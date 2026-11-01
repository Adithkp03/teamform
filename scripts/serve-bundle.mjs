// Serve the Vercel serverless bundle (apps/api/api/index.mjs) over HTTP exactly
// as the platform does: x-matched-path carries the route and the handler
// streams SSE itself. Used by E2E so CI tests the SHIPPED artifact, not src.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3100);
const { default: handler } = await import('../apps/api/api/index.mjs');
createServer((req, res) => {
  req.headers['x-matched-path'] = req.url.split('?')[0];
  handler(req, res);
}).listen(PORT, () => console.log(`[bundle-adapter] serving apps/api/api/index.mjs on :${PORT}`));
