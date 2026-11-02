# TeamForm - Design (1 page)

Race-proof team formation for a 10,000-participant hackathon: teams, expiring invite codes, leader accept/decline, a live looking-for-teammates board, explained teammate suggestions, realtime updates, audit log. Stack: Fastify + TypeScript + Postgres (Neon free tier), React + Vite on Vercel Hobby. No paid tier, no card.

## Data model and invariants
- `hackathons` - one event (team sizes, invite TTL). **Scope: single-hackathon deployment** - no enrollment table; every authenticated account is a participant (multi-hackathon needs enrollment + scoped board queries and cache keys). `profiles` (skills, timezone, looking_for_team, last_active_at). `teams` (leader, invite_code + expiry, wanted_skills; member_count is a trigger-maintained display counter, never used for seat checks). `join_requests` (pending/accepted/declined/cancelled).
- `team_members UNIQUE(hackathon_id, user_id)` - one team per person, enforced by the database. `idempotency_keys` - (user, key) -> stored response; the row insert IS the lock. `domain_events` + `audit_log` - change feed and immutable log, written in the same transaction as the change.

## Race-proofing (precise)
Join-by-code and accept run in one transaction: `SELECT ... FOR UPDATE` locks the team row, seat check and insert happen under that lock, the unique constraint is the final arbiter, and expiry is evaluated inside the accepting statement. 50 concurrent joins for 1 seat: 1 succeeds, 49 get clean 409s (test/race.test.ts + chaos driver with a post-interruption invariant checker).

## Idempotency - exact coverage
Idempotency-Key routes (retries replay the stored response): **create_team, join_by_code, create_join_request, invite rotate** (a retried rotate replays the same code instead of invalidating it). Retry-safe by state machine: accept/decline lock the request FOR UPDATE and 409 any non-pending status (a retried accept cannot double-add); leave/remove are deletes (retry = same end state); profile PUT is last-write-wins.

## Realtime, and the board cache
- **poll mode (production)**: a per-process ~1s ticker dispatches committed domain_events in commit order (advisory-lock sequencer); one dispatch + one events read + one batched leadership lookup per tick serve all clients, so DB cost is flat in client count. ~1s is the poll interval, not a guarantee (observed tail 1.136s under load). Streams rotate at 280s (Vercel cap); clients resume with last-event-id. **listen mode (self-host)**: LISTEN/NOTIFY true push, one Postgres session per connected client - right for one long-lived process, wrong for serverless connection caps.
- **Board cache**: the public board payload (identical for every user; no invite codes or join requests in it) is cached in-process for 1s, keyed by `limit`, capped at 32 entries. Auth runs per request before any cache read. Same-instance mutations invalidate after commit (2xx only) with a generation guard against stale repopulation; cross-instance staleness is bounded by the TTL, never dependent on SSE listeners.

## Security
bcrypt, 15-minute HS256 access JWTs + opaque family-rotated refresh tokens sent as an Authorization header (never in URLs, so they stay out of browser history and query-string logs), leader-only mutations server-side, zod validation, per-identity rate limits incl. SSE connect, CORS pinned to the web origin. Invite codes: 10 chars x 32-char alphabet (50 bits) + expiry + join rate limit. Dev-login compiled out in production; seed users have no password hash.

## Earlier evidence (historical, k6, full 10k/2k seed)
Hot read, cached: local p95 29.7ms; hosted CI 42.99-84.4ms (runs #16-#24, 0 failed; uncached baseline 375-389ms, Postgres-bound). Mixed (103 VUs = 99 readers + 4 paced mutators within rate limits): local p95 45.2ms, 469,770/469,770 checks, 16 cycles, field-level read-your-write, 0 failed; hosted #24 p95 78.1ms, 299,894/299,894 checks. Coexistence (2 instances + 100 SSE + load): p95 31.9ms, 12/12 probes, tail 1.136s. 103 API tests in CI (8 test files). Vercel Hobby forbids production load testing; no production p95 claimed.

## Current evidence and UI (2 Nov 2026)

Repo is PUBLIC: https://github.com/Adithkp03/teamform . Cursor pagination is implemented (`limit`, independent team/people cursors); the UI loads 24 cards and marks truncated counts with +. Light-mode UI uses blue/white surfaces, responsive cards, keyboard focus, loaded-results search and explicit demo email limits. Production email delivery remains disabled. No simulated mail queue exists.

Distinct CI board/mixed-read p95 pairs: `35f54a6` 74.13/206.47ms (**mixed threshold failed**); identical app `0d0b5aa` 23.06/36.20ms (passed); optimized `3868857` 40.62/47.28ms (passed). Source run URLs and full correction history: docs/load-test-report.md. Docs-only `d5c913e` load workflow also passed; its own metrics are not substituted with earlier values. Variability's cause is unproven. No causal speedup, repeatability or production-capacity claim. **Production p95 is unmeasured.** 10k stored users is not 10k concurrent users; board scenario is100 readers, mixed103 VUs.

## Trade-offs
Correctness enforced in the database (slower writes; the locked + unique-constraint paths are proven by the race test and chaos checker, not claimed beyond them). Poll mode: ~1s poll interval for flat DB cost. Board cache: bounded 1s staleness for a ~12x read-cost cut. Free tiers: cold starts and caps, disclosed.

## With one more week
Enrollment + hackathon-scoped board, suggestion-score tuning against real acceptance data, client-facing rate-limit headers.

## Session and token semantics (post-hardening, exact)

Design basis: RFC 9700 (OAuth 2.0 Security BCP) requires public clients to
use refresh-token rotation with reuse detection, and Auth0's rotation docs
(fetched 2026-11-02) define the family model: reuse of an invalidated token
invalidates the entire token family regardless of race order.

- Access tokens are 15-minute JWTs carrying `sub` and `sid`, where `sid` is
  the SESSION FAMILY id. Refresh tokens are opaque secrets; only SHA-256
  hashes are stored. Absolute family lifetime is 30 days from login: rotation
  INHERITS the presented token's expires_at, so active use never extends a
  family's authority (tested).
- Rotation is one transaction per family: a per-family advisory lock +
  re-read under the lock makes rotation atomic with logout and reset - a
  racing logout either sees the fresh successor (and revokes it) or the
  rotation re-reads the revoked state and fails (tested: no survivor either
  way).
- Grace window (`REFRESH_GRACE_MS`, default 10s): racing tabs presenting the
  SAME rotated token inside its window each rotate again INSIDE the family.
  The window is anchored at that token's rotated_at - fixed, never rolling
  (tested). A grace hit never returns a stored successor: no plaintext
  exists server-side, by design. Grace re-rotation is allowed only while the
  family still has a live token: logout/reset/replay-kill revoke every
  family member, and a grace replay into a dead family is rejected - a
  session cannot be resurrected after logout (regression-tested).
- Replay after the window revokes the ENTIRE family (RFC 9700 reuse
  detection); logout revokes the presented token's family; reset revokes
  every family of the user.
- Known residual limit (accepted, not a claim of absolute security): inside
  the 10s window, parallel presentations mint parallel bearer tokens of the
  SAME family. They never extend the family's lifetime, are killed atomically
  by any logout/replay/reset on the family, and exist only because hash-only
  storage rules out returning the same successor token (Auth0's approach).
- SSE revocation: the poll-mode fleet sweep re-validates each connected
  session family at the top of every tick (`EVENTS_POLL_MS`, 1000ms in
  production); a dead family's stream receives `session_revoked` and ends.
  Measured locally: 50 connected clients, all revoked in one statement ->
  50/50 streams ended, 39-42ms wall at a 50ms poll. Measured result, not a
  strict production guarantee.
- Email: when no mail provider is configured (production default), reset and
  verification endpoints return 503 `email_not_configured` and the UI says
  delivery is not configured - it never claims an email was sent.
