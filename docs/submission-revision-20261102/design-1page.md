# TeamForm - design and evidence
Adith K P · 2 Nov 2026 · light-mode revision · public repository

**App:** https://teamform-web.vercel.app · **Repo:** https://github.com/Adithkp03/teamform

## Correctness at the database
Fastify/TypeScript + Postgres, React/Vite. One hackathon per deployment; min/max team sizes, expiring/rotatable invites, leader approval, explained suggestions and audit history. `UNIQUE(hackathon_id,user_id)` enforces one team per person. Join/accept lock the team row in a transaction, count actual memberships under that lock, then insert. A 50-way race for one seat yields 1 winner/49 clean 409 s; the checked final membership count stays 4. Seed users have no password login.

## Retry and event semantics
Idempotency keys cover create-team, join-by-code, create-request and invite-rotate, replaying stored responses. Accept/decline use a locked state transition; repeated nonpending decisions return 409. Leave/remove are retry-safe deletes. A transactional event table and audit row commit with each change. Production SSE uses a shared per-process~1 s poller, rotating streams at 280 s and resuming by event ID. Poll interval is not a delivery guarantee; previous two-browser production observations are recorded in the audit. Local new-UI capture is separately labeled.

## Reads, pagination and matching
Board payload has no invite codes or requests. Auth precedes each cache access. In-process 1 sTTL cache, bounded 32keys, same-generation in-flight sharing, generation guard against stale repopulation; local successful mutations invalidate after commit. Cross-instance staleness is bounded by TTL. Cursor pagination is **implemented**, not future work. UI loads 24 cards; truncated counts say 24+. Search filters loaded cards only. Suggestions expose complementary/shared skills and timezone components.

## Security and UX
bcrypt;15 min access JWTs; opaque hashed refresh tokens with family rotation,30 day absolute family expiry, fixed 10 sgrace, family liveness and replay revocation. Logout/reset serialize with rotation and revoke families. Residual: parallel same-family bearers can exist inside grace, never extending lifetime. zod validation, leader-only server guards, per-IP/identity rate limits, origin-pinned CORS, dev login off in production. Light mode, labeled forms, visible focus,44 pxcontrols,320/390 px fit, keyboard-only flow. Save waits for profile load.

## Measured evidence, not production promises
103 API tests/8 files;6 browser tests locally, including axe serious/critical scan, keyboard, realtime and final-cursor regression. Initial hosted UI E2E 5 passed/1 failed from nonportable screenshot paths; follow-up 2df081d fixes test paths only; its CI/E2E/chaos/load all pass. Chaos is 1 drill with 6 invariant checks, not 6 tests.

Isolated full 10k-profile/2k-team seed. Board 100 readers; mixed 99 readers+4 paced mutators. Distinct CI board/mixed p95: `35f54a6`74.13/206.47 ms (**mixed FAILED**); identical app `0d0b5aa`23.06/36.20 ms (pass); `3868857`40.62/47.28 ms (pass). Run URLs and raw history: `docs/load-test-report.md`. Variability cause unproven; no causal speedup or 10kconcurrent-user claim. **Production p95 unmeasured.** No production load testing.

## Limits and next work
Free Vercel Hobby + Neon; caps/cold starts remain. Real verification/reset email delivery disabled; no durable mail queue or 10k mail simulation built. Single-event scope remains; next: enrollment/scoped board, matching calibration, rate-limit headers and authorized production mail. No paid plan/domain/card or organizer submission.

Latest verified load workflow: https://github.com/Adithkp03/teamform/actions/runs/41407249950 (2df081d, passed; no earlier metric substituted).
