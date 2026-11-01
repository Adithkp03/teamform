# PS1 requirement audit (honest status as of commit dd34f27)

Legend: DONE = implemented + tested/verified; PARTIAL = works, with a stated
limitation; BLOCKED = cannot be demonstrated in the available environment.

## Core requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| Teams with expiring invite codes | DONE | codes rotate + expire (~7d), `teams_invite_code_key` unique; UI shows countdown |
| Leader accept/decline join requests | DONE | leader-only server-side; decline -> later accept = 409 (verified on prod); audit shows actor vs subject |
| Live looking-for-teammates board | DONE | teams + people sides, SSE-driven refresh |
| Race-proof: 50 racers, 1 seat, 1 winner, automated test | DONE | unique constraint + serialized tx; `test/race.test.ts` 50-way race in CI |
| Idempotency | DONE | `idempotency_keys` table, keys on all mutations, replay tests |
| Realtime (SSE) | DONE | poll-mode outbox, shared fleet ticker, cross-instance delivery measured (12/12 probes, 0 missed) |
| Security: auth | DONE | bcrypt + JWT, httpOnly-free Bearer flow, `ALLOW_DEV_LOGIN=false` in prod |
| Security: leader-only | DONE | server-side guards + tests (non-leader accept rejected) |
| Security: brute-force-resistant codes | DONE | 10-char Crockford codes, per-IP/identity rate limits (429 measured) |
| Security: validation | DONE | zod on inputs; Fastify 4xx mapped correctly (empty-JSON-body regression fixed + tested) |
| Audit log | DONE | every mutation; actor vs subject separated (regression test added) |
| Teammate suggestions with explained scoring | DONE | scoring string explains each factor; timezone uses utc_offset_minutes only (no Calcutta/Kolkata divergence) |
| >=20 API tests in CI | DONE | 58 API/integration tests (auth-security, core, race, sse) + 6 chaos tests, counted separately; CI green on every push |
| Seed: 10k users / 2k teams | DONE | `db/seed-sql.mjs`; evidence `docs/seed-evidence/`; seed users have no login |
| Load test: p95 < 200 ms @ 100 concurrent on board | BLOCKED/UNMET | not permitted on the Hobby host (vendor policy, Enterprise-only); local/CI measurements: 401-577 ms (2-vCPU sandbox + 100 SSE), 747-1120 ms (4-vCPU GitHub runner, board-only). 0 failures everywhere. See docs/load-test-report.md |
| React UI, phone + keyboard usable | DONE | mobile 390px + keyboard-only flows verified with screenshots |
| Live URL on free tier | DONE | https://teamform-web.vercel.app + https://teamform-api.vercel.app (Vercel Hobby + Neon free, Singapore) |

## Bonus

| Bonus | Status |
| --- | --- |
| Optimistic UI | DONE (board/team actions) |
| Docker Compose | DONE (`docker-compose.yml` db + api) |
| Metrics/tracing | DONE (`/api/metrics` snapshot; structured request logs) |
| Chaos test | DONE (6/6 vs local DB: DB restart, dropped connections, etc.) |

## Submission deliverables

| Deliverable | Status |
| --- | --- |
| GitHub repo | DONE (private; visibility flip pending user decision) |
| Live URL | DONE |
| Load-test report | DONE (docs/load-test-report.md, honest UNMET headline) |
| 1-page design doc | DONE (docs/design.md) |
| <=5 min walkthrough video | PENDING |
