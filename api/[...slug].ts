// Vercel serverless entry: a single catch-all function handles every /api/* route.
// req.url keeps the original path, so Fastify routing sees /api/teams, etc.
import { buildApp } from '../apps/api/src/app.js';

const app = buildApp();

export default async function handler(req: any, res: any) {
  await app.ready();
  app.server.emit('request', req, res);
}
