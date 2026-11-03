# PS1 requirement audit (reviewed 2 Nov 2026; light-mode revision)

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
| Security: auth | DONE | Firebase Authentication (Spark, no card) is the production identity provider: client-side email/password sign-in, Firebase-delivered verification/reset emails, server-side ID-token verification at `POST /api/auth/firebase` with `email_verified` required from the verified token, uid-bound encrypted Firebase-refresh-token storage so Firebase-side revocation (password reset/change) is enforced at app-token rotation, legacy-account claim gated on legacy password or existing legacy session + verified Firebase identity (never email equality alone). Legacy bcrypt path retained for pre-migration accounts; JWT access (15min) + refresh-token FAMILY rotation: absolute family expiry, fixed grace anchor, family-liveness check on grace replay (a grace replay cannot resurrect a logged-out family - regression-tested after CI caught it), per-family advisory-lock atomic rotate/logout/reset, reuse after grace kills the whole family (RFC 9700); `ALLOW_DEV_LOGIN` present in the prod env but not 'true': `POST /api/auth/dev-login` returns 404 on production (probed post-deploy on aad24a3); recommended hardening: a code-level production refusal, tracked below; residual limit documented in docs/design.md (parallel in-family bearer tokens inside the 10s grace) |
| Security: leader-only | DONE | server-side guards + tests (non-leader accept rejected) |
| Security: brute-force-resistant codes | DONE | 10-char Crockford codes, per-IP/identity rate limits (429 measured) |
| Security: validation | DONE | zod on inputs; Fastify 4xx mapped correctly (empty-JSON-body regression fixed + tested) |
| Audit log | DONE | every mutation; actor vs subject separated (regression test added) |
| Teammate suggestions with explained scoring | DONE | per-candidate grounded reasons derived from the same stored fields the score uses (complementary skills, timezone fit, capacity, recency), displayed timezone string reconciled with the scoring offset at write time so reason text can never contradict the card; timezone uses utc_offset_minutes only (no Calcutta/Kolkata divergence) |
| >=20 API tests in CI | DONE | 118 API/integration tests in 9 files (incl. auth-session family rotation, race, sse), counted separately from the chaos drill (one scenario - API killed mid-join-storm - verified against 6 post-crash DB invariants, not 6 tests). Honest CI record: CI FAILED on 532e0b3 (auth-session race test caught a real flaw - a grace-window replay could resurrect a logged-out token family; fixed in ff11354 with a deterministic regression test); earlier claim of 'green on every push' is retracted. |
| Seed: 10k users / 2k teams | DONE | `db/seed-sql.mjs`; evidence `docs/seed-evidence/`; seed users have no login |
| Load test: p95 < 200 ms @ 100 concurrent on board | MET locally and on hosted CI / not permitted in production | Local, full seed, repeatable (3 runs): p95 138.4-139.8 ms, ~48.5-49k reqs, 0 failures, raw artifacts + before/after dataset counts in docs/loadtest-local/repeatability-20261101/. Harder local scenario (100 SSE + 100-VU board, 2 instances): p95 149.7 ms, 0 failures. Production: Vercel Hobby policy forbids load tests (Enterprise-only; burst was edge-blocked), so no production p95 is claimed. GitHub-hosted runner: MET at p95=76.78 ms (run #16, 111,668 reqs, 0 failed) after the 1s-TTL board cache (5be6cae); uncached hosted baseline preserved at 375-389 ms (runs #14/#15 with CPU-profile artifact). Earlier green loadtest runs were not trustworthy because the k6 step piped through tee without pipefail masked k6's exit-99 on tainted thresholds (attributed via run #13's job log); the workflow now sets pipefail and adds an explicit gate step that fails the job on any violation, so hosted runs show red honestly until the runner meets 200 ms. Full diagnosis + fix history in docs/load-test-report.md. Mix-scenario runs #26/#27/#28 failed mix_full_cycles>=12 at 11 cycles: root-caused via run 41349816532 job log to a k6 script bug (7-char Idempotency-Key for single-digit VUs -> 400 on 4/15 creates; http_req_failed{expected_response:true} stayed 0/88320), fixed in 532e0b3 (key padding, threshold unchanged); mix run on 532e0b3 (run 41352845393) green, failed_req_rate 0.000%. |
| React UI, phone + keyboard usable | DONE | mobile 390px + keyboard-only flows verified with screenshots; 200% browser-zoom flow spec (zoom.spec.ts), 320px reflow spec, onboarding checklist spec, edge-data overflow spec |
| Server-side board search + filters | DONE | search/skill/timezone/capacity/looking-for-team filters resolved server-side and persisted through cursor pagination; min-open-seats filter; regression-tested incl. final-page cursor |
| First-run onboarding | DONE | checklist on the board (complete profile -> find/create team) driven by /api/me my_team_id; onboarding.spec.ts |
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
| GitHub repo | DONE (PUBLIC, authorized and verified 2 Nov 2026): https://github.com/Adithkp03/teamform |
| Live URL | DONE |
| Load-test report | DONE (docs/load-test-report.md: local MET headline with correction history, diagnosis, and honest open items for hosted CI + production) |
| 1-page design doc | DONE (docs/design.md) |
| <=5 min walkthrough video | Revised v8 exported and visually inspected:3m42s, race-first proof, light UI, local approval/two-session/mobile capture, exact latest CI conclusion and limits. Private delivery, previousv7retained. |

## Current benchmark evidence (2 Nov 2026)

Read these separately, not as a guaranteed speed improvement. All are isolated full-seed CI, never Vercel production load. Each pair below is board p95 / mixed-read p95.

- `35f54a6`: **74.13 / 206.47 ms**, mixed p95 threshold FAILED, exit 99. https://github.com/Adithkp03/teamform/actions/runs/41403853587
- `0d0b5aa`: **23.06 / 36.20 ms**, passed, application identical to the preceding run. https://github.com/Adithkp03/teamform/actions/runs/41404383482
- `3868857`: **40.62 / 47.28 ms**, passed. Local duplicate-read optimization is tested, but these variable hosted samples do not establish its performance effect. https://github.com/Adithkp03/teamform/actions/runs/41405128834
- Docs-only `d5c913e`: latest completed load workflow before this UI revision also passed. Do not assign one of the preceding measurements to it: https://github.com/Adithkp03/teamform/actions/runs/41405650692

Production p95 remains **unmeasured**. The dataset contains 10k synthetic profiles and 2k teams; the board scenario uses 100 concurrent readers. Mixed workload uses 99 readers + 4 paced mutators. None demonstrates 10k simultaneous users. Verification/reset email delivery runs through Firebase Auth (Spark); end-to-end receipt at a real inbox is owner-verified post-deploy, and free-tier delivery can land in spam. No durable app-level email queue or 10k-mail simulation exists.

## Light-mode revision verification

Blue/white light interface, responsive navigation, board discovery with loaded-card search, team actions, team workspace, profile and suggestions. Local 320/390px checks and keyboard-only/full-flow/realtime/axe scans are re-run, not assumed from old screenshots. This revision also fixes final-page cursor handling: null next-cursor stays null rather than retaining the previous page cursor.

Current UI revision local verification:103/103API tests (8files),6/6browser tests including keyboard-only, full formation flow, two-session realtime, serious/critical axe scan and320/390px/search/final-cursor regression. A first keyboard run caught profile Save racing its async load; Save now waits for completion and keyboard test awaits that actual readiness before tabbing. Earlier failure is not erased.

Hosted UI revision check:8dc8713CI/API and chaos passed; E2E5passed/1failed because new screenshot paths assumed a local /downloads directory. Changed only the test output paths to Playwright's portable per-test outputPath, not product behavior or pass criteria. Failure retained here. Follow-up CI must verify the correction.

## Verified revision closeout (2 Nov 2026, 13:10 IST)

Test-path correction `2df081d` passed all four automatic workflows, without rerunning or changing thresholds:
- CI/API103tests: https://github.com/Adithkp03/teamform/actions/runs/41407249930
- E2E6tests: https://github.com/Adithkp03/teamform/actions/runs/41407250075
- Chaos: https://github.com/Adithkp03/teamform/actions/runs/41407249901
- Load: https://github.com/Adithkp03/teamform/actions/runs/41407249950

Production `/api/health` verified full `2df081ddce9d62c58d1ebeb4fa826abed93bbd2a`; actual production login pixels show the new light interface. Latest load is reported as a **pass conclusion**, not assigned any earlier run's numeric p95. Source public APIs and the actual GitHub run page were inspected. `8dc8713` E2E portability failure remains above.

Revised private deliverables: `teamform-walkthrough-v8.mp4` (221.68seconds), `teamform-design-final-v4.pdf` (1page), `ps1-requirements-checklist-v9.pdf` (1page). These supersede older editions, which remain retained. Editable content snapshots live in docs/submission-revision-20261102/. Email and production-load gaps remain open.

## Product-improvement revision (3 Nov 2026)

Driven by an external product review of the delivered app. Each review point
was verified against the CURRENT code before work: two points were already
stale (server-side board search/filters across the whole board shipped in the
2 Nov revision; the API suite was 120 tests, not 118). The real gaps found
and closed:

| Area | Status | Evidence |
| --- | --- | --- |
| Organizer operations (API + web console) | DONE | `/api/organizer/*` behind a fail-closed email allowlist (`ORGANIZER_EMAILS`; unset = nobody) that ALSO requires a verified email on the profile (an unverified legacy account holding an allowlisted address gets nothing - regression-tested): event settings with audited before/after + over-cap team report; audit search + CSV export across the event INCLUDING deleted teams (retention is a manual policy - event + 90 days, export before manual cleanup; NO automatic deletion implemented, docs/operations.md); stuck/disputed request resolution as cancel-with-audited-reason (force-accept deliberately absent - seat invariants are never operator-overridden); matching funnel endpoint. 9 API tests (organizer.test.ts) |
| Production observability | DONE | `x-request-id` on every response + structured JSON error logs keyed by it; `/api/metrics` adds DB pool occupancy (`waiting` = saturation), live SSE client count, pool error count; scheduled 15-min GitHub Actions health monitor pings prod API + metrics + web; alerting is GitHub's NATIVE Actions failure notification to the repo owner - the workflow sends nothing itself, no third party, public endpoints only (scheduled-run delay + notification-settings caveats documented); incident/recovery runbook in docs/operations.md |
| Matching quality measurement | DONE (instrumentation) | suggestion serves recorded as impressions; per-suggestion useful/not votes (upsert, replay-safe); organizer funnel reports serves, join-within-7d upper-bound proxy (explicitly labelled: any team join, not suggestion-caused) and vote split; UI states scores are a transparent heuristic being validated |
| Idempotency edge cases | DONE | response-loss replay returns the identical stored response with one effect; a stored 4xx replays after the race resolves (no silent re-execution); stale (>60s) in-flight key takeover runs the presumed-dead attempt; fresh in-flight = 409 retry signal. 4 tests (idempotency-recovery.test.ts) |
| User journeys / edges | DONE | invite expiry: expired code 410 -> TTL fix -> rotate -> join works; leader departure mid-moderation: old leader instantly 403, new leader accepts; legacy signup -> verify link single-use -> forgot/reset revokes sessions + old password; action-token expiry enforced. 4 tests (journeys.test.ts) |
| Mobile accessibility semantics | DONE | 390px axe pass + ARIA naming/state assertions; join/create controls visible and named at phone width; suggestion feedback votes are a named group with aria-pressed. This is semantics verification, NOT VoiceOver/TalkBack testing. 1 browser test (a11y.spec.ts) |

Totals after this revision: 137 API tests (12 files) + 11 browser tests, all
green locally on a fresh migration-only database. Optimistic-UI reconciliation
was re-verified as already present (SSE `sync` forces full refetch; every
conflict path refreshes server state and offers a recovery toast), so no
change was needed there.
