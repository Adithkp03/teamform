# TeamForm - Design (1 page)

Race-proof team formation for 10,000 hackathon participants: teams with expiring invite codes, leader accept/decline, live looking-for-teammates board, teammate suggestions with explained scoring, realtime updates, audit log.

## Stack and why
- **Fastify + TypeScript + Postgres** (single deployable API; also bundled to a Vercel Node function). Postgres is the source of truth and the race arbiter: correctness under contention belongs in the database, not the app.
- **Neon Postgres** (free tier, Singapore) + **Vercel Hobby** (API function + static web, sin1) - no card required on either.
- **React + Vite** frontend, keyboard-first, mobile-friendly.

## Race-proof by construction
- Team size and one-team-per-hackathon are enforced by **SQL constraints + transactional checks in the accepting statement** (`FOR UPDATE` on the team row / serializable-adjacent patterns), not by read-then-write in app code. 50 concurrent accepts for 1 seat produce exactly 1 member; proven by an automated storm test (`test/race.test.ts`) and a chaos driver (`scripts/chaos-join-storm.mjs`) whose invariant checker (`scripts/check-invariants.mjs`) must pass after any interruption.
- Invite codes: 10-char random (56-bit) from `gen_random_uuid`, expiry enforced at join time, brute-force throttled by per-IP/user rate limits.
- Idempotency: every mutating route requires an `Idempotency-Key`; retries return the stored result (`idempotency_keys` table), so a double-click or retry storm never double-joins.

## Realtime (two honest modes)
- **poll mode (production/serverless)**: triggers write thin change rows to `domain_events` in the same transaction as the change. A dispatcher assigns `dispatched_seq` under a transaction-scoped advisory lock, so sequence ranges become visible in commit order and a client cursor **never skips a committed event** (insert-time ids can commit out of order; the dispatcher only assigns committed-visible rows, serialized). SSE handlers poll ~1s through the pooler and filter `join_requests` events per poll against *current* leadership. This is near-real-time (~1s typical, measured), not database push - labeled as such. Streams rotate at 280s (Vercel's 300s cap); clients reconnect with `last-event-id` and replay, or resync on `sync`.
- **listen mode (self-host/Docker)**: LISTEN/NOTIFY true push, one direct session per client - correct for a single long-lived process, wrong for serverless + free-tier connection caps (Neon free: 104 max_connections; pooler cannot carry LISTEN).
- Auth on the stream is the standard `Authorization` header via a fetch-stream reader - tokens never appear in URLs, logs, or browser history.

## Security
- bcrypt password hashes, 7-day HS256 JWTs with issuer check, dev-login compiled out in production (`ALLOW_DEV_LOGIN=false`; seed users have no password hash, so nobody can log in as them).
- Leader-only mutations enforced server-side; input validation with zod; per-identity rate limits incl. SSE connect; CORS restricted to the web origin.

## Scale plan (10k users / 2k teams)
- Seeded via set-based SQL (`db/seed-sql.mjs`, ~13s over WAN). Board reads are indexed (`looking_for_team`, team membership); k6 load test drives 100 concurrent board readers against the deployed API (see `loadtest/`).
- Known free-tier limits, disclosed: Neon scales to zero after 5min idle (cold start seconds, measured separately); Vercel Hobby caps functions at 300s (streams rotate) and monthly usage allotments (1M invocations, 360 GB-hrs) far exceed demo load.
