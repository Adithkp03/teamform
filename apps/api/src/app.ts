import crypto from 'node:crypto';
import { invalidateBoard } from './boardcache.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ApiError } from './errors.js';
import { record, flushOnce } from './metrics.js';
import { prodLike } from './firebase.js';
import authRoutes from './routes/auth.js';
import teamRoutes from './routes/teams.js';
import boardRoutes from './routes/board.js';
import suggestionRoutes from './routes/suggestions.js';
import eventRoutes from './routes/events.js';
import organizerRoutes from './routes/organizer.js';

export function buildApp(opts: { logger?: boolean } = {}) {
  // Every request gets a stable id, echoed as x-request-id and attached to error
  // logs, so a user report can be tied to one exact failing request.
  const app = Fastify({ logger: opts.logger ?? false, genReqId: () => crypto.randomUUID() });

  // CORS fails closed: in production-like environments the allowed origins
  // MUST be configured explicitly (CORS_ORIGIN, comma-separated); an unset
  // variable refuses to boot rather than reflecting every origin with
  // credentials. Local/dev defaults cover vite dev and the e2e preview ports;
  // requests without an Origin header (server-to-server, curl, health checks)
  // are unaffected either way.
  const corsOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (prodLike() && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGIN is not set: refusing to boot with an open cross-origin policy in a production-like environment');
  }
  app.register(cors, {
    origin: corsOrigins.length
      ? corsOrigins
      : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3101', 'http://127.0.0.1:3101'],
  });

  app.addHook('onSend', (req, reply, payload, done) => {
    reply.header('x-request-id', req.id);
    // Deliberate security-header policy (the API serves JSON only): no
    // framing, no content sniffing, no referrer leakage, no resource loading.
    // The web app's CSP is delivered with the static host (vercel.json /
    // nginx.conf) where script/connect needs are known.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    done();
  });

  app.addHook('onResponse', async (req, reply) => {
    record(req.routeOptions?.url ?? '(unmatched)', reply.statusCode, reply.elapsedTime);
    if (Math.random() < 0.01) flushOnce();
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
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled_error', request_id: req.id, route: req.routeOptions?.url ?? req.url, err: String(err?.stack ?? err) }));
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.register(authRoutes);
  app.register(teamRoutes);
  app.register(boardRoutes);
  app.register(suggestionRoutes);
  app.register(eventRoutes);
  app.register(organizerRoutes);

  return app;
}
