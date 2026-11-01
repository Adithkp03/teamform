// Vercel serverless entry: same Fastify app as server.ts, exported as a
// Node (req, res) handler instead of listen(). vercel.json rewrites all
// /api/* traffic to this one function; Vercel puts the original path in
// the x-matched-path header, so we rebuild req.url before handing the
// request to Fastify. SSE routes hijack the raw response and stream
// within the platform's 300s function cap (the events route self-rotates
// at 280s; the client reconnects with its cursor).
import { buildApp } from './app.js';

const app = buildApp();
const ready = app.ready();

export default async function handler(req: any, res: any) {
  const matched = req.headers['x-matched-path'];
  if (typeof matched === 'string' && matched.startsWith('/api/')) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = matched + qs;
  }
  await ready;
  app.server.emit('request', req, res);
}
