import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { authenticate, isSessionValid } from '../auth.js';
import { pool } from '../db.js';
import { rateLimit } from '../ratelimit.js';
import { setSseClients } from '../metrics.js';

/**
 * Server-sent events, two modes (REALTIME_MODE env, default 'poll'):
 *
 * - 'poll' (production/serverless; the mode CI and chaos run): triggers write
 *   thin change rows to domain_events in the same transaction as the change.
 *   Each connected client polls every ~1s through the pooled connection.
 *   A dispatcher assigns gapless dispatched_seq values under a transaction-
 *   scoped advisory lock, so a client cursor never skips a committed event
 *   (see db/migrations/0004_domain_events.sql for the full argument).
 *   This is NEAR-REAL-TIME (~1s detection latency typical, measured in
 *   loadtest/), not database push. Max stream lifetime 280s (Vercel Hobby
 *   caps functions at 300s); the client reconnects with its cursor.
 *
 * - 'listen' (self-hosted/Docker): one dedicated direct session per client
 *   with LISTEN/NOTIFY - true push, but one Postgres session per connected
 *   user, so it does not fit serverless + free-tier connection limits.
 *
 * Both modes: standard Authorization header (fetch-stream reader, never
 * EventSource query tokens). join_requests events are leader-private and are
 * filtered per poll/notification against CURRENT leadership, so a leadership
 * change takes effect within one poll interval. Events are thin "something
 * changed" signals; clients refetch state, and a `sync` event (on connect
 * without cursor, or when the cursor fell behind pruning) forces a full
 * refetch, so state converges even after any disconnect.
 */

const MODE = process.env.REALTIME_MODE || 'poll';
const POLL_MS = Number(process.env.EVENTS_POLL_MS || 1000);
const MAX_STREAM_MS = Number(process.env.EVENTS_MAX_STREAM_MS || 280_000);
const DISPATCH_BATCH = 500;
const ADVISORY_KEY = 727274;

export default async function eventRoutes(app: FastifyInstance) {
  // team_id -> leader_id, short-lived cache (listen mode only; poll mode
  // re-queries leadership every interval)
  const leaderCache = new Map<string, { leader: string; at: number }>();
  async function leaderOf(teamId: string): Promise<string | null> {
    const hit = leaderCache.get(teamId);
    if (hit && Date.now() - hit.at < 10_000) return hit.leader;
    const { rows } = await pool.query('SELECT leader_id FROM teams WHERE id = $1', [teamId]);
    const leader = rows[0]?.leader_id ?? null;
    if (leader) leaderCache.set(teamId, { leader, at: Date.now() });
    return leader;
  }

  function sseHead(req: any, reply: any) {
    reply.hijack();
    // Hijacking the raw response bypasses @fastify/cors, so the SSE headers
    // must mirror its origin policy here - without them a cross-origin web
    // client cannot open the stream at all (caught by the e2e realtime spec).
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    const origin = req.headers.origin as string | undefined;
    const allowed = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : null;
    if (origin && (!allowed || allowed.includes(origin))) {
      headers['access-control-allow-origin'] = origin;
      headers.vary = 'Origin';
    }
    reply.raw.writeHead(200, headers);
  }

  if (MODE === 'listen') {
    app.get('/api/events', { preHandler: authenticate }, async (req: any, reply) => {
      const userId = req.userId as string;
      await rateLimit(`sse:${userId}`, 20, 60);
      sseHead(req, reply);
      reply.raw.write(`event: sync\ndata: {"reason":"connected"}\n\n`);

      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      await client.query('LISTEN board_events');

      const onNotify = (msg: pg.Notification) => {
        void (async () => {
          let payload: any = {};
          try { payload = JSON.parse(msg.payload ?? '{}'); } catch { return; }
          if (payload.t === 'join_requests') {
            if (!payload.team || (await leaderOf(payload.team)) !== userId) return;
          }
          reply.raw.write(`event: change\ndata: ${msg.payload}\n\n`);
        })().catch(() => {});
      };
      client.on('notification', onNotify);

      const heartbeat = setInterval(() => {
        void (async () => {
          if (req.sessionId && !(await isSessionValid(req.sessionId))) {
            try { reply.raw.write(`event: sync\ndata: {"reason":"session_revoked"}\n\n`); reply.raw.end(); } catch { /* gone */ }
            return;
          }
          reply.raw.write(`: hb\n\n`);
        })();
      }, 25_000);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        client.off('notification', onNotify);
        client.end().catch(() => {});
      });
    });
    return;
  }

  // ---- poll mode ----
  // ---- Poll mode: one shared fleet ticker per process. ----
  // A naive per-client poll costs each connection ~3 queries/interval, which
  // saturates a small pool at ~100 concurrent streams (measured: 5s queue
  // timeouts). Instead a single interval does the work for ALL connected
  // clients: one dispatch transaction, one events read from the minimum open
  // cursor, and one batched leadership lookup; per-client work is in-memory
  // filtering and a write. DB cost stays flat as client count grows.
  type SseClient = { userId: string; sessionId?: string; reply: any; cursor: bigint; closed: boolean };
  const clients = new Set<SseClient>();
  let ticking = false;
  let tickCount = 0;

  const fleetTick = async () => {
    if (ticking || clients.size === 0) return;
    ticking = true;
    try {
      tickCount += 1;
      // 0) Session revocation sweep: a client whose session (refresh-token row
      //    id, carried as the access token's sid claim) was revoked - logout,
      //    password reset, replay lockout, revocation from another device -
      //    stops receiving private updates within one poll interval.
      const sids = [...new Set([...clients].filter((c) => !c.closed && c.sessionId).map((c) => c.sessionId!))];
      if (sids.length) {
        const { rows: validRows } = await pool.query(
          `SELECT DISTINCT COALESCE(family_id, id) AS family_id FROM auth_refresh_tokens
           WHERE COALESCE(family_id, id) = ANY($1::uuid[]) AND revoked_at IS NULL AND expires_at > now()`,
          [sids]);
        const valid = new Set(validRows.map((r) => r.family_id as string));
        for (const c of [...clients]) {
          if (c.closed || !c.sessionId || valid.has(c.sessionId)) continue;
          try { c.reply.raw.write(`event: sync\ndata: {"reason":"session_revoked"}\n\n`); c.reply.raw.end(); } catch { /* already gone */ }
          c.closed = true;
          clients.delete(c);
          setSseClients(clients.size);
        }
        if (clients.size === 0) return;
      }
      // 1) Dispatch: assign dispatched_seq to newly committed events.
      //    Serialized across instances by a transaction-scoped advisory lock.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `WITH l AS (SELECT pg_try_advisory_xact_lock($1) AS ok),
                d AS (SELECT de.id FROM domain_events de, l
                      WHERE l.ok AND de.dispatched_seq IS NULL
                      ORDER BY de.id LIMIT $2
                      FOR UPDATE OF de)
           UPDATE domain_events SET dispatched_seq = nextval('domain_events_dispatch_seq')
           WHERE id IN (SELECT id FROM d)`, [ADVISORY_KEY, DISPATCH_BATCH]);
        if (tickCount % 60 === 0) {
          await client.query(`DELETE FROM domain_events WHERE created_at < now() - interval '1 day' AND dispatched_seq IS NOT NULL`);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      // 2) Events after the minimum open cursor cover every client.
      let minCursor: bigint | null = null;
      for (const c of clients) if (!c.closed && (minCursor === null || c.cursor < minCursor)) minCursor = c.cursor;
      if (minCursor === null) return;
      const { rows } = await pool.query(
        `SELECT dispatched_seq, t, op, row_id, team_id FROM domain_events
         WHERE dispatched_seq IS NOT NULL AND dispatched_seq > $1
         ORDER BY dispatched_seq LIMIT 2000`, [minCursor.toString()]);
      if (rows.length === 0) return;

      // 3) One leadership lookup for the whole fleet: join_requests events
      //    stay leader-private, evaluated against CURRENT leadership.
      const userIds = [...new Set([...clients].filter(c => !c.closed).map(c => c.userId))];
      const { rows: ledRows } = await pool.query(
        'SELECT id, leader_id FROM teams WHERE leader_id = ANY($1::uuid[])', [userIds]);
      const ledByUser = new Map<string, Set<string>>();
      for (const r of ledRows) {
        if (!ledByUser.has(r.leader_id)) ledByUser.set(r.leader_id, new Set());
        ledByUser.get(r.leader_id)!.add(r.id);
      }

      // 4) Per client: filter in memory, write, advance its cursor.
      for (const c of clients) {
        if (c.closed) continue;
        const led = ledByUser.get(c.userId) ?? new Set<string>();
        try {
          for (const r of rows) {
            const seq = BigInt(r.dispatched_seq);
            if (seq <= c.cursor) continue;
            if (r.t === 'join_requests' && !led.has(r.team_id)) { c.cursor = seq; continue; }
            const payload = JSON.stringify({ t: r.t, op: r.op, id: r.row_id, team: r.team_id });
            c.reply.raw.write(`id: ${r.dispatched_seq}\nevent: change\ndata: ${payload}\n\n`);
            c.cursor = seq;
          }
        } catch { /* broken socket: close handler cleans up */ }
      }
    } catch {
      // transient DB error: try again next interval
    } finally {
      ticking = false;
    }
  };
  setInterval(() => { void fleetTick(); }, POLL_MS);

  app.get('/api/events', { preHandler: authenticate }, async (req: any, reply: any) => {
    const userId = req.userId as string;
    await rateLimit(`sse:${userId}`, 20, 60);
    sseHead(req, reply);

    // Cursor: Last-Event-ID header from a reconnecting client. Absent = fresh
    // connect: start at the current tail and tell the client to refetch state.
    const { rows: tail } = await pool.query(
      `SELECT max(dispatched_seq) AS hi, min(dispatched_seq) AS lo FROM domain_events WHERE dispatched_seq IS NOT NULL`);
    const hi: bigint = tail[0]?.hi == null ? 0n : BigInt(tail[0].hi);
    const lo: bigint = tail[0]?.lo == null ? 0n : BigInt(tail[0].lo);

    const lastEventId = req.headers['last-event-id'];
    let cursor: bigint;
    if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
      cursor = BigInt(lastEventId);
      if (cursor < lo && hi > 0n) {
        // Fell behind pruning: force a full refetch, continue from tail.
        reply.raw.write(`event: sync\ndata: {"reason":"cursor_pruned"}\n\n`);
        cursor = hi;
      }
    } else {
      cursor = hi;
      reply.raw.write(`event: sync\ndata: {"reason":"connected"}\n\n`);
    }

    const state: SseClient = { userId, sessionId: req.sessionId as string | undefined, reply, cursor, closed: false };
    clients.add(state);
    setSseClients(clients.size);

    const rotate = setTimeout(() => {
      if (state.closed) return;
      // Approaching the platform function cap: ask the client to reconnect.
      reply.raw.write(`id: ${state.cursor}\nevent: rotate\ndata: {"reason":"max_stream_age"}\n\n`);
      cleanup();
      reply.raw.end();
    }, MAX_STREAM_MS);

    const heartbeat = setInterval(() => { if (!state.closed) reply.raw.write(`: hb\n\n`); }, 25_000);

    const cleanup = () => {
      state.closed = true;
      clients.delete(state);
      setSseClients(clients.size);
      clearTimeout(rotate);
      clearInterval(heartbeat);
    };
    req.raw.on('close', cleanup);
  });
}

