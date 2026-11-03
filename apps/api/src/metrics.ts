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

// ---- Durable rollups (review-driven): the in-process counters above die with
// each serverless instance. flushToDb upserts the delta since the last flush
// into 5-minute windows and prunes anything older than 14 days, so operational
// history is durable, aggregated across instances, and bounded. Best-effort:
// flushes run on an interval (long-running server), on 1% of responses, and on
// every /api/metrics read; analytics must never break the request path.
const WINDOW_MS = 5 * 60 * 1000;
const RETENTION = "14 days";
const flushed = new Map<string, RouteMetrics>();
let flushing: Promise<unknown> | null = null;

// Lazy import breaks the db.ts <-> metrics.ts module cycle: db.ts calls
// setPoolStats during its own initialization, so a static import here leaves
// db.ts bindings in the temporal dead zone when the bundle evaluates metrics
// first (crashed the API at boot in the chaos container).
async function db() { return (await import('./db.js')).pool; }

export async function flushToDb(now = Date.now()): Promise<number> {
  const pool = await db();
  const windowStart = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
  let n = 0;
  for (const [route, m] of routes) {
    const prev = flushed.get(route);
    const dReq = m.requests - (prev?.requests ?? 0);
    const dErr = m.errors - (prev?.errors ?? 0);
    const dLat = m.latency.map((c, i) => c - (prev?.latency[i] ?? 0));
    if (dReq === 0 && dErr === 0 && dLat.every((d) => d === 0)) continue;
    await pool.query(
      `INSERT INTO metrics_rollups (window_start, route, requests, errors, latency_counts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (window_start, route) DO UPDATE SET
         requests = metrics_rollups.requests + EXCLUDED.requests,
         errors = metrics_rollups.errors + EXCLUDED.errors,
         latency_counts = (SELECT array_agg(COALESCE(a,0)+COALESCE(b,0))
                           FROM unnest(metrics_rollups.latency_counts, EXCLUDED.latency_counts) AS u(a,b))`,
      [windowStart, route, dReq, dErr, dLat],
    );
    flushed.set(route, { requests: m.requests, errors: m.errors, latency: [...m.latency] });
    n++;
  }
  await pool.query(`DELETE FROM metrics_rollups WHERE window_start < now() - interval '${RETENTION}'`);
  return n;
}

export function flushOnce(): void {
  if (!flushing) {
    flushing = flushToDb().catch(() => {}).finally(() => { flushing = null; });
  }
}

export async function durable24h() {
  const pool = await db();
  const { rows } = await pool.query(
    `SELECT route, sum(requests)::int AS requests, sum(errors)::int AS errors
     FROM metrics_rollups WHERE window_start > now() - interval '24 hours'
     GROUP BY route ORDER BY requests DESC`,
  );
  return rows;
}
