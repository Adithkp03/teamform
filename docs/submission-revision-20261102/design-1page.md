# TeamForm - design and evidence
Adith K P · 3 Nov 2026 · Firebase-auth revision · public repository

**App:** https://teamform-web.vercel.app · **Repo:** https://github.com/Adithkp03/teamform

## Correctness at the database
Fastify/TypeScript + Postgres, React/Vite. One hackathon per deployment; min/max team sizes, expiring/rotatable invites, leader approval, explained suggestions and audit history. `UNIQUE(hackathon_id,user_id)` enforces one team per person. Join/accept lock the team row in a transaction, count actual memberships under that lock, then insert. A 50-way race for one seat yields 1 winner/49 clean 409s; the checked final membership count stays 4. Seed users have no password login.

## Identity: Firebase Authentication
Sign-in is Firebase email/password on the free Spark tier (no card). Firebase itself sends verification and password-reset email. The client exchanges its Firebase ID token **and** refresh token at `/api/auth/firebase`; the server verifies the ID token against Google (signature, issuer, audience, expiry), requires `email_verified` in the verified token, and requires the presented refresh token to redeem to the same uid before storing it AES-256-GCM-encrypted for revocation checks at app-token rotation (password reset/change kills the app family). Legacy bcrypt accounts keep working; claiming one needs the legacy password or an authenticated legacy session plus the verified Firebase identity - never email equality alone. `profiles.firebase_uid` carries a partial unique index (migration 0010). Dev login is refused at boot in any production-like env, and the stray prod env flag was removed.

## Retry and event semantics
Idempotency keys cover create-team, join-by-code, create-request and invite-rotate, replaying stored responses. Accept/decline use a locked state transition; repeated nonpending decisions return 409. Leave/remove are retry-safe deletes. A transactional event table and audit row commit with each change. Production SSE uses a shared per-process ~1s poller, rotating streams at 280s and resuming by event ID. Poll interval is not a delivery guarantee.

## Reads, pagination and matching
Board payload has no invite codes or requests. Auth precedes each cache access. In-process 1s TTL cache, bounded 32 keys, generation guard; local mutations invalidate after commit. Cursor pagination implemented. Search plus skill/timezone/capacity/looking filters run **server-side** and persist through pagination; min-open-seats filter included. Suggestions show grounded per-candidate reasons derived from the same stored fields the score uses; display timezone is reconciled with the scoring offset at write time. First-run checklist guides profile -> team.

## Session security
15-min access JWTs; opaque hashed refresh tokens with family rotation, 30-day absolute family expiry, fixed 10s grace, family liveness and replay revocation. Firebase credential validity is re-proven before rotation; a Google outage yields a state-preserving 503, an invalid credential revokes the family. zod validation, leader-only server guards, per-IP/identity rate limits, origin-pinned CORS.

## Measured evidence, not production promises
120 API tests / 9 files on a fresh migration-only database; 10 browser tests (flows, realtime, keyboard, axe, 200% zoom, 320/390px, onboarding, edge data). Hosted CI on deployed commit `9f683ea`: test, e2e, chaos and k6 load all pass (runs 41511777781 / 41511777767 / 41511777766 / 41511777921). Local full 10k-profile/2k-team seed: board p95 138-140ms at 100 readers, 0 failures. Historical 206.47ms mixed-load miss kept beside the passes in `docs/load-test-report.md`. **Production p95 unmeasured** - Vercel Hobby forbids load tests.

## Limits and next work
Free Vercel Hobby + Neon free + Firebase Spark; caps/cold starts remain; free-tier mail can land in spam. One owner-verified real-inbox receipt is still pending for the full migration claim. No durable app-level mail queue or 10k-mail simulation. Single-event scope remains; next: enrollment/scoped board, matching calibration, rate-limit headers. No paid plan/domain/card or organizer submission.

Latest verified deploy: `9f683ea` (+ docs `df57083`) on main; production health matches.
