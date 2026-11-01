# TeamForm - Design (1 page)

Race-proof team formation for a 10,000-participant hackathon: teams, expiring invite codes, leader accept/decline, a live looking-for-teammates board, explained teammate suggestions, realtime updates, audit log. Stack: Fastify + TypeScript + Postgres (Neon free tier), React + Vite on Vercel Hobby. No paid tier, no card.

## Data model and invariants
- `hackathons` - one event (team sizes, invite TTL). **Scope: single-hackathon deployment** - no enrollment table; every authenticated account is a participant (multi-hackathon needs enrollment + scoped board queries and cache keys). `profiles` (skills, timezone, looking_for_team, last_active_at). `teams` (leader, invite_code + expiry, wanted_skills; member_count is a trigger-maintained display counter, never used for seat checks). `join_requests` (pending/accepted/declined/cancelled).
- `team_members UNIQUE(hackathon_id, user_id)` - one team per person, enforced by the database. `idempotency_keys` - (user, key) -> stored response; the row insert IS the lock. `domain_events` + `audit_log` - change feed and immutable log, written in the same transaction as the change.

## Race-proofing (precise)
Join-by-code and accept run in one transaction: `SELECT ... FOR UPDATE` locks the team row, seat check and insert happen under that lock, and the unique constraint is the final arbiter; expiry is evaluated inside the accepting statement. 50 concurrent joins for 1 seat: 1 succeeds, 49 get clean 409s (test/race.test.ts plus a chaos driver whose invariant checker must pass after interruption).

## Idempotency - exact coverage
Idempotency-Key routes (retries replay the stored response): **create_team, join_by_code, create_join_request, invite rotate** (a retried rotate replays the same code instead of invalidating it). Retry-safe by state machine: accept/decline lock the request FOR UPDATE and 409 any non-pending status (a retried accept cannot double-add); leave/remove are deletes (retry = same end state); profile PUT is last-write-wins.

## Realtime, and the board cache
- **poll mode (production)**: a per-process ~1s ticker dispatches committed domain_events in commit order (advisory-lock sequencer); one dispatch + one batched read serves all clients, so DB cost is flat in client count. Streams rotate at 280s (Vercel cap); clients resume with last-event-id. **listen mode (self-host)**: LISTEN/NOTIFY true push, one Postgres session per connected client - right for one long-lived process, wrong for serverless connection caps.
- **Board cache**: the public board payload (identical for every user; no invite codes or join requests in it) is cached in-process for 1s, keyed by `limit`, capped at 32 entries. Auth runs per request before any cache read. Same-instance mutations invalidate after commit (2xx only) with a generation guard against stale repopulation; cross-instance staleness is bounded by the TTL, never dependent on SSE listeners.

## Security
bcrypt, 7-day HS256 JWTs sent as an Authorization header (never in URLs, so they stay out of browser history and query-string logs), leader-only mutations server-side, zod validation, per-identity rate limits incl. SSE connect, CORS pinned to the web origin. Invite codes: 10 chars from a 32-char alphabet (50 bits) + expiry + join rate limit. Dev-login compiled out in production; seeded users have no password hash.

## Evidence (k6, 100 concurrent, full 10k/2k seed)
Hot read, cached: local p95 29.7ms; hosted CI p95 76.8-84.4ms (runs #16/#17, 0 failed; uncached hosted baseline 375-389ms, Postgres-CPU-bound). Mixed (99 readers + paced mutation churn): local p95 46.4ms, 476k/476k checks incl. read-your-write, 0 failed. Coexistence (2 instances + 100 SSE + load): p95 31.9ms, 12/12 cross-instance probes <= ~1.1s. 75 API tests in CI. Vercel Hobby forbids production load testing, so no production p95 is claimed.

## Trade-offs
Correctness in the database (slower writes, races impossible by construction). Poll mode: ~1s latency for flat DB cost. Board cache: bounded 1s staleness for a ~12x read-cost cut. Free tiers: cold starts and caps, disclosed.

## With one more week
Enrollment + hackathon-scoped board, board cursor pagination, scheduled k6 mix against staging, suggestion explanations in the UI, client-facing rate-limit headers.
