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
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.register(authRoutes);
  app.register(teamRoutes);
  app.register(boardRoutes);
  app.register(suggestionRoutes);
  app.register(eventRoutes);

  return app;
}
