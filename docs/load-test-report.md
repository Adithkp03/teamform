# Load test report: GET /api/board

Target from the problem statement: p95 < 200 ms with 100 concurrent users.

## Status

- **Deployed target (the number that counts): pending deployment.** Will be
  measured with k6 (`loadtest/board.k6.js`) from a GitHub Actions runner, with
  runner geography, warm/cold state, error rate, and repeated runs reported.
- **Local baseline (measured 2026-11-01): below.** Local numbers characterize
  query efficiency and code overhead only; the sandbox CPU is much weaker than
  production serverless and the numbers should NOT be read as production
  latency.

## Local baseline (autocannon, 100 connections, 30s, warm)

Environment: sandboxed container, 2 shared vCPUs, Node 22 (tsx, no build),
PostgreSQL 18 (embedded, same box), seeded with 10,003 users / 2,000 teams /
4,966 memberships. Response payload ~38 KB (50 teams + 50 people default page).

| Metric | Value |
| --- | --- |
| Requests | 8k in 30s (~259 req/s) |
| Latency avg | 384 ms |
| Latency p97.5 | 426 ms |
| Latency max | 559 ms |
| Errors | 0 |

Analysis: both board queries execute in **4.1 ms and 2.6 ms** (EXPLAIN ANALYZE,
sequential scans acceptable at this size, partial index on `looking_for_members`
available). The gap to 384 ms is single-process CPU: JSON serialization of
~38 KB responses at ~260 req/s on 2 shared cores, plus tsx (uncompiled) overhead.
On Vercel serverless, concurrency is spread across instances and each instance
serves far fewer simultaneous requests, so per-request latency is expected to be
dominated by the DB round trip instead. The deployed measurement will confirm or
refute that expectation; if p95 misses 200 ms, the fixes in priority order are:
compiled build (drop tsx), smaller default page, HTTP caching with a short
max-age, and a materialized board table.

## Reproduce

```bash
docker compose up -d db api && node db/seed.mjs
npx autocannon -c 100 -d 30 -H "authorization=Bearer <token>" http://localhost:3000/api/board
# against the live URL (k6):
k6 run -e BASE_URL=https://<deployed> -e TOKEN=<jwt> loadtest/board.k6.js
```
