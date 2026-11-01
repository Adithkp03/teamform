import { invalidateBoard } from './boardcache.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ApiError } from './errors.js';
import { record } from './metrics.js';
import authRoutes from './routes/auth.js';
import teamRoutes from './routes/teams.js';
import boardRoutes from './routes/board.js';
import suggestionRoutes from './routes/suggestions.js';
import eventRoutes from './routes/events.js';

export function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });

  app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true });

  app.addHook('onResponse', async (req, reply) => {
    record(req.routeOptions?.url ?? req.url, reply.statusCode, reply.elapsedTime);
  });

  // Board-cache invalidation at ROOT scope so it covers every route plugin
  // (Fastify encapsulates plugin-local hooks). onSend runs BEFORE the
  // response bytes leave: a client can never receive a mutation's 2xx and
  // then read a pre-mutation board snapshot on this instance (an onResponse
  // hook left a real race - the client could re-read in the microseconds
  // before the hook fired; caught by the mix workload's field-level
  // read-your-write checks). Only 2xx clears the cache, so a rolled-back
  // transaction (4xx/5xx) never invalidates. Cross-instance freshness is
  // bounded by the 1s TTL, independent of SSE listeners (see boardcache.ts).
  app.addHook('onSend', (req, reply, payload, done) => {
    if (req.method !== 'GET' && reply.statusCode < 300 && /^\/api\/(teams|requests|me)(\/|$)/.test(req.url)) {
      invalidateBoard();
    }
    done();
  });

  app.setErrorHandler((err: any, req: any, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err?.code === '23505') {
      // Unique-constraint backstop fired: the invariant held, map to a clean 409.
      return reply.code(409).send({ error: { code: 'conflict', message: 'Conflicts with an existing record' } });
    }
    if (err?.code === '23503') {
      return reply.code(409).send({ error: { code: 'conflict', message: 'Referenced record no longer exists' } });
    }
    if (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    }
    console.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.register(authRoutes);
  app.register(teamRoutes);
  app.register(boardRoutes);
  app.register(suggestionRoutes);
  app.register(eventRoutes);

  return app;
}
