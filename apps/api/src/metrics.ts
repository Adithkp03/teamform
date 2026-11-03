// Minimal in-process metrics: request counts, error counts, latency histogram for
// the board endpoint. Per-instance on serverless (documented in the design doc);
// enough to operate and to sanity-check load-test numbers server-side.
const buckets = [25, 50, 100, 200, 400, 1000, Infinity];

interface RouteMetrics {
  requests: number;
  errors: number;
  latency: number[]; // bucket upper bounds hit
}

const routes = new Map<string, RouteMetrics>();
const startedAt = Date.now();

// Live gauges, wired from db.ts (pool) and routes/events.ts (SSE clients).
let sseClients = 0;
let poolErrors = 0;
let poolStats: { total: number; idle: number; waiting: number } = { total: 0, idle: 0, waiting: 0 };

export function setSseClients(n: number) { sseClients = n; }
export function recordPoolError() { poolErrors++; }
export function setPoolStats(total: number, idle: number, waiting: number) { poolStats = { total, idle, waiting }; }

export function record(route: string, statusCode: number, durationMs: number) {
  let m = routes.get(route);
  if (!m) {
    m = { requests: 0, errors: 0, latency: new Array(buckets.length).fill(0) };
    routes.set(route, m);
  }
  m.requests++;
  if (statusCode >= 500) m.errors++;
  const idx = buckets.findIndex((b) => durationMs <= b);
  m.latency[idx === -1 ? buckets.length - 1 : idx]++;
}

export function snapshot() {
  const out: Record<string, unknown> = {
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    sse_clients: sseClients,
    db_pool: { ...poolStats, errors: poolErrors },
    routes: {},
  };
  for (const [route, m] of routes) {
    (out.routes as any)[route] = {
      requests: m.requests,
      errors: m.errors,
      latency_bucket_bounds_ms: buckets.map((b) => (b === Infinity ? '+Inf' : b)),
      latency_bucket_counts: m.latency,
    };
  }
  return out;
}
