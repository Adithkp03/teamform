# Load test report: GET /api/board

Target from the problem statement: **p95 < 200 ms with 100 concurrent users.**

## Status

- **Deployed target (the number that counts): PENDING deployment.** It will be
  measured with k6 (`loadtest/board.k6.js`, thresholds `p(95)<200`) from a
  GitHub Actions runner, reporting runner geography, warm/cold state, error
  rate, and repeated runs.
- **Local baseline: measured 2026-11-01, raw output preserved in
  `docs/loadtest-local/`.** Local numbers characterize the code and queries on
  a weak shared sandbox; they are NOT a prediction of production latency.

## Local measurements

Environment: sandboxed container, 2 shared vCPUs, Node 22 running via tsx
(uncompiled), PostgreSQL 18 embedded on the same box. Dataset: exactly 10,000
seed users (+3 clearly labeled `(demo)` fixtures), 2,000 teams, 4,966
memberships. Tool: autocannon, JSON output in `docs/loadtest-local/`.

| Run | Requests | Avg | p50 | p97.5 | p99 | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| 1 connection, 10s | 1.3k (~131 rps) | 7.2 ms | 7 ms | 9 ms | 14 ms | 0 |
| 100 connections, 30s | 8k (~259 rps) | 383.9 ms | 378 ms | 427 ms | 435 ms | 0 |

(autocannon's summary reports p97.5/p99 rather than p95; the deployed k6 run
reports exact p95. p50 vs p97.5 spread is small: 378 vs 427 ms.)

## What limits local throughput (measured, not assumed)

1. **Database is not the limiter.** EXPLAIN ANALYZE on the seeded data: board
   teams query 4.1 ms, people query 2.6 ms (partial index on
   `looking_for_members`; sequential scans acceptable at this size). With the
   API's PG pool of 5, the database alone could serve ~700 rps.
2. **Per-request floor is 7.2 ms** (1-connection run): 6.7 ms queries + ~0.5 ms
   everything else.
3. **The single Node process is CPU-saturated at 100 connections.** Little's
   law: 100 concurrent / 258.8 rps = 386 ms mean residence time, matching the
   measured 384 ms. Capacity x service time = 258.8 x 7.2 ms = 1.86, i.e. the
   process consumes ~1.9 of the 2 available cores. The extra ~0.5 ms/request of
   CPU-side work (JSON serialization of ~38 KB pages, tsx-executed code, pg
   driver) on this weak shared CPU is the bottleneck, and 100 concurrent
   requests simply queue behind it.

Expected production behavior, to be confirmed by the deployed run: Vercel
spreads concurrency across instances (each instance sees few simultaneous
requests) and runs compiled JS on much faster cores, so per-request latency
should approach the 1-connection floor plus network RTT to the database. If the
deployed p95 misses 200 ms, the fixes in order: co-locate DB and function
region, shorter cache-friendly board payload, and a materialized board table.

## Reproduce

```bash
docker compose up -d db api && node db/seed.mjs   # 10,000 users, 2,000 teams
TOKEN=$(curl -s -X POST localhost:3000/api/auth/dev-login -H 'content-type: application/json' \
  -d '{"display_name":"LT"}' | jq -r .token)
npx autocannon -c 1   -d 10 --json -H "authorization=Bearer $TOKEN" http://localhost:3000/api/board
npx autocannon -c 100 -d 30 --json -H "authorization=Bearer $TOKEN" http://localhost:3000/api/board
# deployed (exact p95):
k6 run -e BASE_URL=https://<deployed> -e TOKEN=<jwt> loadtest/board.k6.js
```
