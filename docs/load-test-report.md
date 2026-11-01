# Load test report: GET /api/board

Target from the problem statement: **p95 < 200 ms with 100 concurrent users.**

## Status, stated plainly

- **Production measurement: not permitted by the host.** Vercel's policy
  allows load testing only on Enterprise plans
  (<https://vercel.com/kb/guide/what-s-vercel-s-policy-regarding-load-testing-deployments>);
  an unannounced 100-VU burst against the Hobby deployment was auto-mitigated
  by the Vercel Security Checkpoint (99.94% of requests rejected at the edge -
  that measures rejected edge traffic, not app throughput). There is no
  supported way to load test the live URL on this plan, so **no production p95
  is claimed anywhere in this submission**.
- **Local / CI measurement: reproducible, seeded, raw artifacts committed.**
  All numbers below are against the full seed (10,003 users, 2,000 teams,
  6,000 members). They characterize the code; they are not a production
  guarantee.

## Correction

An earlier chat update quoted a local k6 PASS (p95 = 98.86 ms). That run used
a **near-empty local database** and does not represent the seeded dataset. It
is superseded by the full-seed measurements below and appears nowhere in the
repo docs.

## Environment

Sandboxed container, 2 shared vCPUs, Node 22 via tsx (uncompiled), PostgreSQL
16 embedded on the same box, k6 v0.55.0. Dataset: 10,003 users, 2,000 teams,
6,000 members (`db/seed-sql.mjs`). Query cost is not the bottleneck: EXPLAIN
ANALYZE on the full seed shows the board teams query at 4.5 ms and the people
query at 2.4 ms (existing partial index `teams_board_idx`). The sandbox CPU
(2 shared vCPUs running API + Postgres + k6 + 100 SSE streams) is the
limiting factor in every measurement below; see
`docs/loadtest-local/cpu-during-load.txt`.

## Measurements (all: 100 VUs, no think time, 60 s, `loadtest/board.k6.js`)

| Scenario | Requests | Failures | p95 | Notes |
| --- | --- | --- | --- | --- |
| Board only, near-empty DB (superseded) | 68,876 | 0 | 98.9 ms | kept only to explain the correction above |
| Board + 100 SSE streams, one API instance, full seed | 12,659 | 0 | 577 ms | raw: `single-instance-20261101.json` |
| Board + 100 SSE streams (50+50), TWO API instances, full seed | 16,493 | 0 | 401 ms | raw: `multi-instance-20261101.json` |

The p95 < 200 ms target is **not met in any environment available to this
project**, and that is the honest headline:

| Environment | Scenario | Requests | Failures | p95 |
| --- | --- | --- | --- | --- |
| 2-vCPU sandbox | board-only, near-empty DB (superseded) | 68,876 | 0 | 98.9 ms |
| 2-vCPU sandbox | board + 100 SSE, 1 API instance, full seed | 12,659 | 0 | 577 ms |
| 2-vCPU sandbox | board + 100 SSE, 2 API instances, full seed | 16,493 | 0 | 401 ms |
| 4-vCPU GitHub runner (run #1, commit 1d6e8c9) | board-only, full seed | 9,941 | 0 | 747 ms |
| 4-vCPU GitHub runner (run #2, commit 805d56b) | board-only, full seed | 5,783 | 0 | 1,120 ms |

The CI-stack runs (`.github/workflows/loadtest-local.yml`, every push) are
board-only - the PS minimum scenario; the sandbox runs add 100 concurrent SSE
streams - a harder robustness scenario. Query cost is NOT the limiter
(EXPLAIN ANALYZE on the full seed: 4.5 ms / 2.4 ms per board query, with or
without fresh planner statistics - measured before/after VACUUM ANALYZE on
identical data: 3.1/1.9 ms vs 2.2/1.8 ms). Zero failures in every run. The
limiter is CPU contention on shared free compute (API + Postgres + the k6
generator on the same small box; GitHub runner CPUs measure slower than the
sandbox's). A `VACUUM ANALYZE` was added to `db/seed-sql.mjs` on a
planner-stats hypothesis that measurement then REFUTED - it is kept as bulk-
load hygiene, not as a performance fix. Closing the last gap would need less
contended compute (a paid runner class, a deployed region-colocated stack,
or a host that permits load testing), not more query work.

## Realtime under load (SSE, poll mode)

Poll mode uses one **shared fleet ticker per API process**: a single interval
does one dispatch transaction (serialized across processes by a
transaction-scoped advisory lock), one events read from the minimum open
cursor, and one batched leadership lookup for all connected clients; each
client's work is in-memory filtering plus a socket write. This replaced a
per-client poll that exhausted the 5-connection pool at ~100 concurrent
streams (measured: 5 s pool-queue timeouts, write 500s). Multi-instance note:
the ticker is per process, so N serverless instances cost N x ~3 queries per
second against Postgres, not 1; the advisory lock prevents duplicate dispatch
across instances, and per-client cursors keep delivery correct per instance.

Multi-instance measurement (2 processes, same DB, 100 SSE streams total,
k6 100 VUs against instance A): 12/12 team-create probes were delivered to
listeners on **both** instances, writes alternating A/B. Delivery latency
after write completion: min 31 ms, median ~500 ms, max 1,203 ms at a 1 s poll
interval. 0 missed events, 0 failed writes, all 100 streams alive at the end.
Raw: `docs/loadtest-local/multi-instance-20261101.json`.

Correctness properties covered by tests (`apps/api/test/sse.test.ts`):
leader-only visibility of join_requests events re-evaluated every interval,
Last-Event-ID resume, `sync` forced when the cursor falls behind pruning, and
stream rotation before the serverless max duration.

## Reproduce

```bash
docker compose up -d db api && node db/seed-sql.mjs   # 10,003 users, 2,000 teams
TOKEN=$(curl -s -X POST localhost:3000/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"lt@example.com","password":"load-pass-1","display_name":"LT"}' | jq -r .token)
k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=$TOKEN loadtest/board.k6.js
```

For an external target use the guarded manual workflow
`.github/workflows/loadtest.yml`: it refuses Vercel hosts outright (vendor
policy above) and requires typing CONFIRMED for any other external host after
verifying the host permits load testing.
