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

## What limits local throughput (measured)

Run conditions: API, Postgres, and the autocannon client all co-located on one
2-vCPU sandbox; PG pool of 5; seeded 10,000 users / 2,000 teams.

1. **Query cost is small in isolation.** EXPLAIN ANALYZE on the seeded data:
   board teams query 4.1 ms, people query 2.6 ms (partial index on
   `looking_for_members`).
2. **Per-request floor is 7.2 ms** (1-connection run, avg).
3. **At 100 connections the box is CPU-saturated.** Measured during steady load
   (top snapshot, 3 s in): %Cpu 96.7 us / 3.3 sy / 0.0 id; five Postgres
   backend processes at 26-47% each (~165% combined), the Node API process at
   ~33%, the autocannon client at ~7%. Load average 1.9 on 2 cores.
   Little's law is consistent with the measurement (100 concurrent / 258.8 rps
   = 386 ms mean residence vs 384 ms measured) but says nothing about cause.
4. **What this does and does not show.** The database backends, not the API
   process, consume the majority of CPU under this load, so the earlier
   "single Node process CPU-bound" hypothesis is refuted by measurement. The
   split between SQL execution, per-connection backend overhead (no pooler in
   this setup), and planning cost is not resolved here - that needs database
   profiling (e.g. pg_stat_statements), which this sandbox does not have
   installed. The deployed k6 run (client off-box, real instance sizing) is the
   measurement that counts for the p95 < 200 ms requirement; these local
   numbers only reproduce the invariant behavior (0 errors, 3k requests/10s)
   and give the 1-connection floor.

Expected production behavior, to be confirmed by the deployed run: serverless
instances spread concurrency and a managed Postgres is better provisioned than
this sandbox, so per-request latency should approach the 1-connection floor
plus network RTT to the database. If the deployed p95 misses 200 ms, the fixes
in order: co-locate DB and function region, connection pooling (PgBouncer /
Supabase pooler), shorter board payload, and a materialized board table.

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
