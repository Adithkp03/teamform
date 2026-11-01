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
bcrypt, 7-day HS256 JWTs sent as an Authorization header (never in URLs, so they stay out of browser history and query-string logs), leader-only mutations server-side, zod validation, per-identity rate limits incl. SSE connect, CORS pinned to the web origin. Invite codes: 10 chars x 32-char alphabet (50 bits) + expiry + join rate limit. Dev-login compiled out in production; seed users have no password hash.

## Evidence (k6, 100 concurrent, full 10k/2k seed)
Hot read, cached: local p95 29.7ms; hosted CI 42.99-84.4ms (runs #16-#24, 0 failed; uncached baseline 375-389ms, Postgres-bound). Mixed (103 VUs = 99 readers + 4 paced mutators within rate limits): local p95 45.2ms, 469,770/469,770 checks, 16 cycles, field-level read-your-write, 0 failed; hosted #24 p95 78.1ms, 299,894/299,894 checks. Coexistence (2 instances + 100 SSE + load): p95 31.9ms, 12/12 probes, tail 1.136s. 75 API tests in CI. Vercel Hobby forbids production load testing; no production p95 claimed.

## Trade-offs
Correctness enforced in the database (slower writes; the locked + unique-constraint paths are proven by the race test and chaos checker, not claimed beyond them). Poll mode: ~1s poll interval for flat DB cost. Board cache: bounded 1s staleness for a ~12x read-cost cut. Free tiers: cold starts and caps, disclosed.

## With one more week
Enrollment + hackathon-scoped board, board cursor pagination, suggestion-score tuning against real acceptance data, client-facing rate-limit headers.

## Session and token semantics (post-hardening, exact)

- Access tokens are 15-minute JWTs carrying `sub` and `sid` (the refresh-token
  row id of the session they were issued with). Refresh tokens are opaque
  30-day secrets; only their SHA-256 hash is stored.
- Rotation: presenting a valid refresh token revokes it (with `rotated_at`)
  and mints a new session row. The old session id dies with it: open SSE
  streams on that session receive `session_revoked` and the client reconnects
  with the new pair. Other devices have their own session rows and are not
  affected by another device's rotation.
- Grace window (`REFRESH_GRACE_MS`, default 10s): two tabs racing to present
  the SAME rotated token inside the window each get a FRESH, independent
  session (no stored successor is ever returned, so no plaintext successor
  exists server-side). The number of sessions a grace storm can mint is
  bounded by the refresh rate limit (30/min/IP; tested: 40 rapid replays
  yield <= 28 sessions + 429s, all distinct). After the window, presenting a
  rotated token is treated as replay and revokes ALL of the user's sessions.
- Logout and password reset revoke WITHOUT a grace window (no `rotated_at`),
  so their streams end immediately at the next poll.
- SSE revocation latency: the poll-mode fleet sweep re-validates sessions at
  the top of every tick (`EVENTS_POLL_MS`, 1000ms in production). Under the
  CI-measured test (50 connected clients, one-statement revoke), all streams
  ended within the measured wall time logged by the suite; this is a measured
  target, not a strict guarantee under production load.
- Email: when no mail provider is configured (production default), reset and
  verification endpoints return 503 `email_not_configured` and the UI says
  delivery is not configured - it never claims an email was sent.
