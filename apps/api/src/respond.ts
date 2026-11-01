import type { HandlerResult } from './idempotency.js';

/** Unpacks a {status, body} handler result into a Fastify response. */
export const respond = (fn: (req: any) => Promise<HandlerResult>) =>
  async (req: any, reply: any) => {
    const result = await fn(req);
    reply.code(result.status);
    return result.body;
  };
