# PS1 requirement audit (honest status as of commit ff11354; supersedes the dd34f27 version)

Legend: DONE = implemented + tested/verified; PARTIAL = works, with a stated
limitation; BLOCKED = cannot be demonstrated in the available environment.

## Core requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| Teams with expiring invite codes | DONE | codes rotate + expire (~7d), `teams_invite_code_key` unique; UI shows countdown |
| Leader accept/decline join requests | DONE | leader-only server-side; decline -> later accept = 409 (verified on prod); audit shows actor vs subject |
| Live looking-for-teammates board | DONE | teams + people sides, SSE-driven refresh |
| Race-proof: 50 racers, 1 seat, 1 winner, automated test | DONE | unique constraint + serialized tx; `test/race.test.ts` 50-way race in CI |
| Idempotency | DONE (exact coverage) | `idempotency_keys` table; Idempotency-Key routes: create_team, join_by_code, create_join_request, invite rotate (retried rotate replays the same code). Retry-safe by state machine, not keyed: accept/decline (FOR UPDATE + 409 on non-pending), leave/remove (deletes), profile PUT (last-write-wins). Replay tests incl. rotate |
| Realtime (SSE) | DONE, verified in production | poll-mode outbox, shared fleet ticker, cross-instance delivery measured (12/12 probes, 0 missed). Production two-browser proof (2026-11-02, commit 15add73+): separate browser profiles on teamform-web.vercel.app against teamform-api.vercel.app - team created in one browser appeared on the other's open board without reload; join request (POST 201) and leader accept propagated live both directions (team 20b55ff5-21c2-40f8-93a3-9ccc5a02f1fb, history timestamps 2:52:55/2:58:41/2:58:46 IST). Cross-origin SSE required a real code fix (hijacked replies mirror CORS headers). Logout revocation observed twice in prod: open stream closed ~3-4s after logout (1s poll sweep; locally 39-42ms at 50ms poll) - observed behavior, not a latency guarantee. |
| Security: auth | DONE | bcrypt + JWT access (15min) + refresh-token FAMILY rotation: absolute family expiry, fixed grace anchor, family-liveness check on grace replay (a grace replay cannot resurrect a logged-out family - regression-tested after CI caught it), per-family advisory-lock atomic rotate/logout/reset, reuse after grace kills the whole family (RFC 9700); `ALLOW_DEV_LOGIN=false` in prod; residual limit documented in docs/design.md (parallel in-family bearer tokens inside the 10s grace) |
| Security: leader-only | DONE | server-side guards + tests (non-leader accept rejected) |
| Security: brute-force-resistant codes | DONE | 10-char Crockford codes, per-IP/identity rate limits (429 measured) |
| Security: validation | DONE | zod on inputs; Fastify 4xx mapped correctly (empty-JSON-body regression fixed + tested) |
| Audit log | DONE | every mutation; actor vs subject separated (regression test added) |
| Teammate suggestions with explained scoring | DONE | scoring string explains each factor; timezone uses utc_offset_minutes only (no Calcutta/Kolkata divergence) |
| >=20 API tests in CI | DONE | 99 API/integration tests in 8 files (incl. auth-session family rotation, race, sse), counted separately from the chaos drill (one scenario - API killed mid-join-storm - verified against 6 post-crash DB invariants, not 6 tests). Honest CI record: CI FAILED on 532e0b3 (auth-session race test caught a real flaw - a grace-window replay could resurrect a logged-out token family; fixed in ff11354 with a deterministic regression test); earlier claim of 'green on every push' is retracted. |
| Seed: 10k users / 2k teams | DONE | `db/seed-sql.mjs`; evidence `docs/seed-evidence/`; seed users have no login |
| Load test: p95 < 200 ms @ 100 concurrent on board | MET locally and on hosted CI / not permitted in production | Local, full seed, repeatable (3 runs): p95 138.4-139.8 ms, ~48.5-49k reqs, 0 failures, raw artifacts + before/after dataset counts in docs/loadtest-local/repeatability-20261101/. Harder local scenario (100 SSE + 100-VU board, 2 instances): p95 149.7 ms, 0 failures. Production: Vercel Hobby policy forbids load tests (Enterprise-only; burst was edge-blocked), so no production p95 is claimed. GitHub-hosted runner: MET at p95=76.78 ms (run #16, 111,668 reqs, 0 failed) after the 1s-TTL board cache (5be6cae); uncached hosted baseline preserved at 375-389 ms (runs #14/#15 with CPU-profile artifact). Earlier green loadtest runs were not trustworthy because the k6 step piped through tee without pipefail masked k6's exit-99 on tainted thresholds (attributed via run #13's job log); the workflow now sets pipefail and adds an explicit gate step that fails the job on any violation, so hosted runs show red honestly until the runner meets 200 ms. Full diagnosis + fix history in docs/load-test-report.md. Mix-scenario runs #26/#27/#28 failed mix_full_cycles>=12 at 11 cycles: root-caused via run 41349816532 job log to a k6 script bug (7-char Idempotency-Key for single-digit VUs -> 400 on 4/15 creates; http_req_failed{expected_response:true} stayed 0/88320), fixed in 532e0b3 (key padding, threshold unchanged); mix run on 532e0b3 (run 41352845393) green, failed_req_rate 0.000%. |
| React UI, phone + keyboard usable | DONE | mobile 390px + keyboard-only flows verified with screenshots |
| Live URL on free tier | DONE | https://teamform-web.vercel.app + https://teamform-api.vercel.app (Vercel Hobby + Neon free, Singapore) |

## Bonus

| Bonus | Status |
| --- | --- |
| Optimistic UI | DONE (board/team actions) |
| Docker Compose | DONE (`docker-compose.yml` db + api) |
| Metrics/tracing | DONE (`/api/metrics` snapshot; structured request logs) |
| Chaos test | DONE (drill: API killed mid-join-storm; 6/6 post-crash DB invariants hold vs local stack) |

## Submission deliverables

| Deliverable | Status |
| --- | --- |
| GitHub repo | DONE (private; visibility flip pending user decision) |
| Live URL | DONE |
| Load-test report | DONE (docs/load-test-report.md: local MET headline with correction history, diagnosis, and honest open items for hosted CI + production) |
| 1-page design doc | DONE (docs/design.md) |
| <=5 min walkthrough video | PENDING |
