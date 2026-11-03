import { buildApp } from './app.js';

const app = buildApp({ logger: true });
const port = Number(process.env.PORT || 3000);

// Persist metric rollups every minute on the long-running server (serverless
// flushes on reads + a 1% response sample instead).
setInterval(() => { import('./metrics.js').then((m) => m.flushOnce()); }, 60_000).unref();

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  console.error(err);
  process.exit(1);
});
