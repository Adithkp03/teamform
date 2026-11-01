// Vercel serverless entry: same Fastify app as server.ts, exported as a
// Node (req, res) handler instead of listen(). SSE routes hijack the raw
// response and stream within the platform's 300s function cap (the events
// route self-rotates at 280s; the client reconnects with its cursor).
import { buildApp } from './app.js';

const app = buildApp();
const ready = app.ready();

export default async function handler(req: any, res: any) {
  await ready;
  app.server.emit('request', req, res);
}
