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
- **GitHub-hosted CI runner: NOT MET, p95 = 378 ms** (run #10, commit
  `1d0e133`, 17,838 requests, 295 req/s, 0 failed requests; artifact
  `k6-ci-results`). Pre-fix runs measured 747/1,120 ms. The hosted runner is
  consistently ~2.7x slower than the local sandbox on identical code and
  seed (139 ms local vs 378 ms CI); the cause is an unproven environment
  hypothesis (runner CPU class), not investigated further because the local
  reproduction is the repeatable standard and production load testing is
  not permitted. **Tooling finding (resolved):** runs #5-#11 showed green even when the
  threshold was tainted (#10's artifact records `X 'p(95)<200'
  p(95)=378.04ms` and `thresholds["p(95)<200"] = true`). The cause is now
  attributed: the k6 step piped through `tee` without `set -o pipefail`,
  so the step's exit status came from `tee` (0) and masked k6's own exit
  code. Hosted k6 exits 99 on crossed thresholds exactly like local
  v0.55 - proven in run #13's job log ("thresholds on metrics
  'http_req_duration' have been crossed", "Process completed with exit
  code 99") once `pipefail` was set. The earlier wording blaming an
  unattributed hosted-k6 exit behavior is retracted. The workflow now
  has both `set -o pipefail` and an explicit gate step that reads the
  exported summary JSON and fails the job on any tainted threshold, so
  hosted runs go red honestly until the runner meets 200 ms. Run #6's
  earlier failure was separately explained from its job log: a genuine
  SSE storm-test flake (read loop stopped at 10 ids), fixed in `7531164`
  and confirmed green in CI #38.
- **Hosted-runner bottleneck: measured, no longer a hypothesis.** Run #14
  (`61d22b7`, p95=375.4 ms, 18,012 reqs, 0 failed) carried a per-process
  CPU sampler during the k6 step, printed to the job log and persisted in
  the artifact as `ci-profile.txt`. Samples during the run:
  `postgres=122-127%`, `node=47-50%`, `k6=11%` - the hosted run is
  Postgres-CPU-bound. Local EXPLAIN (ANALYZE, BUFFERS) on the full seed
  shows both board queries already near-optimal (teams page: 1.04 ms,
  163 buffers, top-N heapsort; people page: 0.28 ms, index-only anti
  join via `profiles_board_idx`), so more indexing is not the lever.
- **Cache experiment (local, uncommitted, reverted):** a 500 ms
  in-process cache of the board response cut Postgres to 11-12% CPU and
  p95 to 31.55 ms (272,424 iters vs ~48k uncached; node becomes the
  bottleneck at 56-70%, k6 at 52%). Scaled by the measured ~2.7x
  hosted/local gap this projects ~85 ms on the hosted runner - under the
  200 ms target. Caveats: the experiment had no invalidation; a real
  implementation must invalidate on domain events (the dispatcher
  already sees every change) and disclose up-to-TTL staleness. This is
  the next warranted fix, chosen by the profiling above.
- **RESOLVED on the hosted runner (5be6cae):** the 1s-TTL board cache
  (root-scope onSend pre-response invalidation, auth outside the cache, 32-entry
  cap, cross-instance staleness bounded by TTL and pinned by test) took
  the hosted run to **p95 = 76.78 ms** (run #16, 111,668 reqs, 0.000%
  failed, max 2,243.7 ms cold-start spike; k6 v2.3.0). Local committed
  measurement: p95 = 29.69 ms, 285,551 reqs, 0 failed, postgres ~8% CPU
  (was 83-125% uncached). Uncached evidence preserved above (runs
  #14/#15 red at 375-389 ms with the ci-profile.txt sampler). The cached
  payload is public and user-independent; same-instance mutations are
  visible immediately, cross-instance within 1s (disclosed, matching the
  poll-mode realtime latency). Mixed workload added (loadtest/board-mix.k6.js, in CI):
  103 VUs total - 99 board readers + 4 paced mutator VUs (8 users)
  running create/join/leave cycles within the app's own rate limits
  (5 creates/min/user; an unpaced variant tripped 429s by design with
  zero 5xx, so the committed workload paces below the limit). Local,
  full seed: read p95 45.24ms, 469,770/469,770 checks - including
  field-level read-your-write (team id/name/member_count verified after
  create, join and leave) - 0.00% failed. Hosted CI run #24 (cca3c28):
hot read p95 42.99 ms (206,551 reqs, 0 failed) and mixed read p95
78.05 ms, 299,894/299,894 checks, 16 full create/join/leave cycles,
0.000% failed - the workflow publishes both result tables to the run
job summary on every push. The field-level checks caught
  a real race: invalidation ran in an onResponse hook, which fires after
  response bytes leave, so an instant client re-read could see the
  pre-mutation snapshot (~2/20 window); invalidation moved to onSend
  (before bytes leave), and the checks now pass 100%.
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

### Failed run kept on record: hosted run #20 (aa5238f)

https://github.com/Adithkp03/teamform/actions/runs/41337522593 - FAILED.
Hot step green (hosted p95 55.49 ms, 153,878 requests, 0.000% failed). The
mixed step crossed `http_req_failed rate<0.01`: 1,796 of 1,798 `create 201`
checks failed while every read and field-level read-your-write check passed
(hosted mixed read p95 92.74 ms). Run #20 itself did not log the failing
responses' statuses; the explanation below reproduces the same failure
class locally with logged status/body and is consistent with #20's counts
(2 passes then a self-sustaining failure loop on every mutator VU):

- Reproduced initial failure class: `409 already_in_team` on create. k6
  does not assign scenario VU ids in scenario order - the script pinned
  leader/joiner pairs by `__VU >= 100`, but mutator VUs received ids
  outside that range (observed 40-43 locally), so all four shared one
  pair and concurrent creates conflicted. (Concurrent same-user creates
  also surfaced the app's unique-index backstop: loser gets a generic
  409, no corruption.)
- Amplification: the mutator's early returns skipped the pacing sleep, so
  the first 409 put each VU into a no-sleep retry loop for the rest of
  the run. Locally, mutations had never failed, so both defects were
  invisible until the field-level checks and hosted timing exposed them.

Fix (a4ba8ae, hardened in the commit that superseded it): every failure
path is paced (no hot loop), the first failure per VU is logged with
status+body into the job log, a failed joiner-leave leaves no orphaned
team across iterations (per-VU stuck-team retry; leader leave transfers
leadership, joiner leave deletes the last-member team), pairs are created
per-VU by lazy signup with no __VU assumptions, and a `mix_full_cycles >=
12` counter threshold makes a vacuous green impossible - a run whose
creates all fail now fails even with a clean read p95 (validated by a
forced-400 negative test: 4 logged failures, 0 full cycles, threshold
crossed). Re-run with these fixes: green, 469,770/469,770 checks, 0
failed requests, 16 full cycles, read p95 45.24 ms (local, full seed).

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


## 2 November 2026: post-sanitization CI run

Source `35f54a6` adds history-provenance documentation after a token-only history rewrite; application code is unchanged from original `8e46e34` (rewritten `17c1fec`). Run https://github.com/Adithkp03/teamform/actions/runs/41403853587 failed the mixed workload at read p95 **206.47ms** against unchanged `p(95)<200`. It completed 57,459 HTTP requests with 0 failures, 114,816/114,816 checks passing and 12 full mutation cycles. k6 exited 99. This is a measured latency miss; runner variation is a hypothesis, not an established explanation. Prior passing benchmark pairs remain historical results, not a guarantee or a measurement of this run. No production load test was performed.


## 3 November 2026: enriched per-run reporting (p50/p95/p99, failures, cold vs warm)

Every push run of the CI-stack workflow now publishes, per k6 scenario in the
GitHub job summary (no artifact download needed): p50, p95, p99, average, max,
request count, failed-request count and rate. The 100-VU board scenario runs
twice back-to-back - the first pass after a fresh seed + API boot (cold) and
an immediate rerun (warm) - so cold-vs-warm latency is measured on every run,
and the published history of these tables across runs is the run-to-run
variation record (the samples table above already shows hosted spread of
23-378 ms on comparable code).

First measured sample, run https://github.com/Adithkp03/teamform/actions/runs/41686436569 (commit `8d775d9`): board cold p50/p95/p99 = 54.98/68.78/80.31 ms (105,033 reqs, max 281.74 ms), board warm 56.35/64.44/74.37 ms (104,693 reqs, max 104.01 ms), mixed-read p50/p95/p99 = 67.51/80.80/90.85 ms (169,418/169,418 checks, 16 full cycles); 0 failed requests in all three scenarios. Cold-vs-warm delta is small on the hosted runner; the cold-start max spike seen in run #16 (2,243.7 ms) did not recur here (max 281.74 ms).

Test-environment limits, stated plainly: this is the GitHub-hosted CI stack -
a shared-vCPU `ubuntu-latest` runner with PostgreSQL 16 in a service container
and k6 on the same box, seeded to 10,000 users / 2,000 teams. It is an
isolated, repeatable regression environment, not staging and not production:
absolute numbers are runner-shaped (hosted samples run ~2.7x slower than the
local sandbox on identical code and seed), so they bound and compare, they do
not certify production latency. Production load testing is not permitted by
the host (Vercel policy, quoted above), so no production p95 exists or is
claimed.

## 2 November 2026: distinct repeat and in-flight-read optimization samples

All following measurements use the isolated CI stack and full seed, not production. The threshold remains `p(95)<200`.

| Tested source | Run | Board p95 / requests | Mixed read p95 / requests | Mixed checks | Full cycles | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `35f54a6` | https://github.com/Adithkp03/teamform/actions/runs/41403853587 | 74.13ms / 94,993 | 206.47ms / 57,459 | 114,816/114,816 | 12 | Mixed latency threshold missed |
| `0d0b5aa` | https://github.com/Adithkp03/teamform/actions/runs/41404383482 | 23.06ms / 302,394 | 36.20ms / 245,134 | 490,138/490,138 | 16 | Passed |
| `3868857` | https://github.com/Adithkp03/teamform/actions/runs/41405128834 | 40.62ms / 170,549 | 47.28ms / 155,892 | 311,654/311,654 | 16 | Passed |

Every board/mixed sample in this table recorded 0.000% HTTP failures. `35f54a6` and `0d0b5aa` have identical application code: their spread is observed run-to-run variability, not an established explanation of its cause. `3868857` shares concurrent cache-miss reads for the same key and generation, with authentication still before lookup, unchanged TTL and post-commit invalidation. Four regression tests cover sharing, invalidation races, failed-loader retry and bounded bookkeeping. All 103 API tests, five browser tests and the crash-recovery drill passed on this source.

A separate small local diagnostic (existing local test dataset, not the full seed) observed 100 simultaneous cold-cache reads issue 200 SQL queries before sharing and two afterward. One local p95 pair was 105.44ms before / 33.45ms after; warm reads issued zero SQL queries. This supports duplicate-query elimination, not a production-throughput claim or attribution of the earlier CI miss. The optimized hosted result is slower than the faster pre-change sample. A passing sample does not prove repeatable latency or a production guarantee.
