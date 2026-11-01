import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { authenticate } from '../auth.js';
import { pool } from '../db.js';
import { rateLimit } from '../ratelimit.js';

/**
 * Server-sent events over Postgres LISTEN/NOTIFY. Portable across any
 * Postgres host (Neon, Render, local); no vendor realtime dependency.
 *
 * Auth: standard Authorization header (the web client uses a fetch-stream
 * reader, not EventSource), so tokens never appear in URLs, access logs, or
 * browser history.
 *
 * Privacy: board-wide changes (teams, members, looking-for-team profiles) are
 * public board data and broadcast to every signed-in user. join_requests
 * changes are private to the team's leader and are forwarded only to that
 * leader (lookup cached briefly per team).
 *
 * Events are thin "something changed" signals: on receipt (and on every
 * connect/reconnect via the initial `sync` event) clients refetch state, so
 * events missed during a disconnect are recovered by resync, not replay.
 */
export default async function eventRoutes(app: FastifyInstance) {
  // team_id -> leader_id, short-lived cache to keep hot streams cheap
  const leaderCache = new Map<string, { leader: string; at: number }>();
  async function leaderOf(teamId: string): Promise<string | null> {
    const hit = leaderCache.get(teamId);
    if (hit && Date.now() - hit.at < 10_000) return hit.leader;
    const { rows } = await pool.query('SELECT leader_id FROM teams WHERE id = $1', [teamId]);
    const leader = rows[0]?.leader_id ?? null;
    if (leader) leaderCache.set(teamId, { leader, at: Date.now() });
    return leader;
  }

  app.get('/api/events', { preHandler: authenticate }, async (req: any, reply) => {
    const userId = req.userId as string;
    await rateLimit(`sse:${userId}`, 20, 60);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`event: sync\ndata: {"reason":"connected"}\n\n`);

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('LISTEN board_events');

    const onNotify = (msg: pg.Notification) => {
      void (async () => {
        let payload: any = {};
        try { payload = JSON.parse(msg.payload ?? '{}'); } catch { return; }
        // join_requests are leader-private; everyone else gets no signal.
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
}
