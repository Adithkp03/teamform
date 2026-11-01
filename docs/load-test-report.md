# Load test report: GET /api/board

Target from the problem statement: **p95 < 200 ms with 100 concurrent users.**

## Status, stated plainly

- **Local, full seed, board-only (the PS minimum scenario): MET, repeatable.**
  Three back-to-back 100-VU / 60 s runs at commit `01dd52c`/`0ad0acb`:
  p95 = 138.41 ms, 139.75 ms, 139.33 ms; ~48.5-49k requests each, 0 failures.
  Dataset counts captured immediately before and after each run; zero
  `member_count` drift. Raw: `docs/loadtest-local/repeatability-20261101/`.
- **Local, full seed, harder robustness scenario (100 SSE streams + 100-VU
  board load, two API instances): MET post-fix.** p95 = 149.73 ms, 45,941
  requests, 0 failures, all 100 streams alive, 12/12 write probes delivered
  to listeners on both instances (51-955 ms after write at a 1 s poll).
  Raw: `docs/loadtest-local/multi-instance-postfix-20261101.json`.
- **GitHub-hosted CI runner: open.** The `Load test (CI stack)` workflow runs
  the same k6 suite on every push. Pre-fix runs measured 747 ms and 1,120 ms
  (0 failures). The first post-fix run (#6, commit `0ad0acb`) failed in 1m32s;
  the cause is **not yet established** (the token available to this project
  lacks Actions log scope). The workflow now publishes k6 metrics and dataset
  counts to the job summary on every run, so each push self-reports; the
  hosted-runner result will be recorded here once read.
- **Production measurement: not permitted by the host.** Vercel allows load
  testing only on Enterprise plans
  (<https://vercel.com/kb/guide/what-s-vercel-s-policy-regarding-load-testing-deployments>);
  an unannounced 100-VU burst against the Hobby deployment was auto-mitigated
  by the Vercel Security Checkpoint (99.94% of requests rejected at the edge).
  No production p95 is claimed anywhere in this submission.

## Correction history

Two earlier local PASS figures were dataset-invalid and are superseded:
p95 = 98.86 ms (near-empty DB) and p95 = 72.3 ms (a test suite had truncated
the seed before the run; caught and re-measured). Neither appears as a result
anywhere. The pre-fix full-seed baseline was p95 = 372 ms
(`baseline-fullseed-20261101-k6-summary.json`).

## Diagnosis (all steps measured)

1. Full-seed baseline: p95 = 372 ms, 290 req/s, Postgres at ~1.6 cores while
   the API sat at ~0.2 cores - database CPU-bound, not framework-bound
   (per-process sampler: `board-pass-20261101-cpu.txt` shows the post-fix
   balance).
2. tsx vs compiled esbuild server: 372 vs 370 ms - transpile overhead ruled
   out.
3. Authenticated no-op control (`GET /api/me`, same 100 VUs): p95 = 29.6 ms
   at 4,926 req/s (`api-me-20261101-k6-summary.json`) - framework + JWT auth
   ruled out.
4. EXPLAIN ANALYZE on the full seed: the two board queries cost ~8.3 ms CPU
   per request (aggregate over all 6,000 `team_members` rows + merge join
   over 2,001 leader profiles before LIMIT). At ~290 req/s that alone pins
   ~2.4 cores. An earlier planner-stats hypothesis was tested with
   before/after VACUUM ANALYZE on identical data and refuted.

## Fix (migrations 0005 + 0006, board query rewrite)

- `teams.member_count`, maintained transactionally by trigger on
  `team_members` inserts/deletes. Display/filter only: seat enforcement still
  locks the team row and counts live, so the 50-racers/1-seat property does
  not depend on the counter. Reconciliation is pinned by a dedicated suite
  (`apps/api/test/member-count.test.ts`: join/leave/remove/last-member
  delete/failed-join rollback/12-way concurrent join storm).
- Partial index `profiles_board_idx`; people query now 0.25 ms.
- Teams query rewritten page-first (CTE) so profiles are joined for only the
  50 returned rows; both board queries run concurrently.
- `member_count` is board-visible, so the teams notify trigger fires on
  counter updates (0006) - board clients see count changes live; a dedicated
  SSE test asserts this.
- Result: teams query 5.4 -> ~0.4 ms, people 2.9 -> 0.25 ms; board p95
  372 -> ~139 ms at ~800 req/s, Postgres ~0.9 cores, API ~0.6 cores.

## Environment

Sandboxed container, 2 shared vCPUs, Node 22 (tsx and compiled esbuild bundle
measured; both pass), PostgreSQL 16 embedded on the same box, k6 v0.55.0.
Dataset: ~10,000 users, 2,000 teams, 6,000 members (`db/seed-sql.mjs`, with
VACUUM ANALYZE as bulk-load hygiene).

## Realtime under load (SSE, poll mode)

Poll mode uses one **shared fleet ticker per API process**: a single interval
does one dispatch transaction (serialized across processes by a
transaction-scoped advisory lock), one events read from the minimum open
cursor, and one batched leadership lookup for all connected clients; each
client's work is in-memory filtering plus a socket write. Multi-instance note:
the ticker is per process, so N serverless instances cost N x ~3 queries per
second against Postgres, not 1; the advisory lock prevents duplicate dispatch
across instances, and per-client cursors keep delivery correct per instance.

Multi-instance measurement post-fix (2 processes, same DB, 100 SSE streams
total, k6 100 VUs against instance A): 12/12 team-create probes delivered to
listeners on **both** instances, writes alternating A/B; delivery latency
51-955 ms at a 1 s poll; 0 missed events, 0 failed writes, all 100 streams
alive at the end; board p95 149.73 ms during the run.

Correctness properties covered by tests (`apps/api/test/sse.test.ts`):
leader-only visibility of join_requests events re-evaluated every interval,
Last-Event-ID resume, `sync` forced when the cursor falls behind pruning,
stream rotation before the serverless max duration, gapless delivery under
concurrent writers (asserted semantically, not by a brittle event count), and
member_count invalidation events reaching connected board clients.

## Reproduce

```bash
docker compose up -d db api && node db/seed-sql.mjs   # ~10,000 users, 2,000 teams
TOKEN=$(curl -s -X POST localhost:3000/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"lt@example.com","password":"load-pass-1","display_name":"LT"}' | jq -r .token)
k6 run -e BASE_URL=http://localhost:3000 -e TOKEN=$TOKEN loadtest/board.k6.js
```

For an external target use the guarded manual workflow
`.github/workflows/loadtest.yml`: it refuses Vercel hosts outright (vendor
policy above) and requires typing CONFIRMED for any other external host after
verifying the host permits load testing.
