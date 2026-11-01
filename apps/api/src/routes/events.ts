import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { authenticate } from '../auth.js';
import { pool } from '../db.js';
import { rateLimit } from '../ratelimit.js';

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

  function sseHead(reply: any) {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }

  if (MODE === 'listen') {
    app.get('/api/events', { preHandler: authenticate }, async (req: any, reply) => {
      const userId = req.userId as string;
      await rateLimit(`sse:${userId}`, 20, 60);
      sseHead(reply);
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

      const heartbeat = setInterval(() => reply.raw.write(`: hb\n\n`), 25_000);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        client.off('notification', onNotify);
        client.end().catch(() => {});
      });
    });
    return;
  }

  // ---- poll mode ----
  app.get('/api/events', { preHandler: authenticate }, async (req: any, reply) => {
    const userId = req.userId as string;
    await rateLimit(`sse:${userId}`, 20, 60);
    sseHead(reply);

    // Cursor: Last-Event-ID header from a reconnecting client. Absent = fresh
    // connect: start at the current tail and tell the client to refetch state.
    const { rows: tail } = await pool.query(
      `SELECT max(dispatched_seq) AS hi, min(dispatched_seq) AS lo FROM domain_events WHERE dispatched_seq IS NOT NULL`);
    let hi: bigint = tail[0]?.hi == null ? 0n : BigInt(tail[0].hi);
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

    let closed = false;
    let pollCount = 0;
    const startedAt = Date.now();

    const poll = async () => {
      if (closed) return;
      try {
        // 1) Dispatch: assign dispatched_seq to newly committed events.
        //    Serialized across all connected clients by a transaction-scoped
        //    advisory lock; losers no-op. Retention prune is opportunistic.
        pollCount += 1;
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
          if (pollCount % 60 === 0) {
            await client.query(`DELETE FROM domain_events WHERE created_at < now() - interval '1 day' AND dispatched_seq IS NOT NULL`);
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }

        // 2) Per-poll authorization: teams this user leads RIGHT NOW.
        const { rows: led } = await pool.query('SELECT id FROM teams WHERE leader_id = $1', [userId]);
        const ledSet = new Set(led.map((r: any) => r.id as string));

        // 3) Read committed events after the cursor.
        const { rows } = await pool.query(
          `SELECT dispatched_seq, t, op, row_id, team_id FROM domain_events
           WHERE dispatched_seq IS NOT NULL AND dispatched_seq > $1
           ORDER BY dispatched_seq LIMIT 200`, [cursor.toString()]);
        for (const r of rows) {
          if (r.t === 'join_requests' && !ledSet.has(r.team_id)) continue;
          const payload = JSON.stringify({ t: r.t, op: r.op, id: r.row_id, team: r.team_id });
          reply.raw.write(`id: ${r.dispatched_seq}\nevent: change\ndata: ${payload}\n\n`);
          cursor = BigInt(r.dispatched_seq);
        }
      } catch {
        // transient DB error: try again next interval
      }
      if (!closed) timer = setTimeout(tick, POLL_MS);
    };

    const rotate = setTimeout(() => {
      if (closed) return;
      // Approaching the platform function cap: ask the client to reconnect.
      reply.raw.write(`id: ${cursor}\nevent: rotate\ndata: {"reason":"max_stream_age"}\n\n`);
      cleanup();
      reply.raw.end();
    }, MAX_STREAM_MS);

    const heartbeat = setInterval(() => { if (!closed) reply.raw.write(`: hb\n\n`); }, 25_000);

    let timer: NodeJS.Timeout;
    const tick = () => { void poll(); };
    const cleanup = () => {
      closed = true;
      clearTimeout(rotate);
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
    };
    req.raw.on('close', cleanup);
    timer = setTimeout(tick, POLL_MS);
  });
}
