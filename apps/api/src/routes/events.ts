import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { verifyToken } from '../auth.js';
import { parse } from '../util.js';
import { rateLimit } from '../ratelimit.js';

/**
 * Server-sent events over Postgres LISTEN/NOTIFY. Portable across any
 * Postgres host (Neon, Render, local); no Supabase dependency.
 *
 * Events are thin "something changed" signals: on receipt (and on every
 * connect/reconnect via the initial `sync` event) clients refetch board
 * state, so events missed during a disconnect are recovered by the resync,
 * not by replay. Heartbeat comments keep proxies from idling the stream.
 */
export default async function eventRoutes(app: FastifyInstance) {
  app.get('/api/events', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.query);
    const userId = verifyToken(token); // throws 401 on invalid/expired
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
      reply.raw.write(`event: change\ndata: ${msg.payload ?? '{}'}\n\n`);
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
