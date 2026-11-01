# TeamForm design doc (1 page)

## Data model (PostgreSQL)

`hackathons(slug, team_size_min, team_size_max)` - `profiles(id, skills[], timezone, utc_offset_minutes, looking_for_team)` - `teams(hackathon_id, leader_id, invite_code UNIQUE, invite_expires_at, looking_for_members, wanted_skills[])` - `team_members(team_id, hackathon_id, user_id, role, PRIMARY KEY(team_id,user_id), UNIQUE(hackathon_id,user_id))` - `join_requests(status pending|accepted|declined|cancelled, partial UNIQUE on one pending per (team,user))` - `idempotency_keys(PRIMARY KEY(user_id,key), state, stored response)` - `audit_log(append-only, written in the same transaction as the change)` - `rate_limits(fixed windows, no Redis needed)`.

The load-bearing invariant "one team per person per hackathon" is a **database unique constraint**, not application code - even a buggy or crashed API cannot violate it.

## How races are prevented

Every mutation is one transaction. The join path (`join-by-code`) first does
`SELECT ... FOR UPDATE` on the team row. All concurrent joiners for a team
serialize on that row lock, so the `count(members) < max` check runs against
committed truth; exactly one of 50 racers passes. Accepting a join request locks
**both** the request row and the team row (same order everywhere, so no
deadlock), then re-checks `status='pending'`, capacity, and the requester's
membership inside the lock. Leadership transfer, last-member delete and invite
rotation take the same team-row lock, so leave-vs-join and delete-vs-join
interleavings are linearizable: a join either commits before the delete or sees
the team gone (404).

Proof, not promises: `test/race.test.ts` runs 50 concurrent joins for the last
seat (exactly 1 wins, count never exceeds max, exactly 1 audit entry), 10
concurrent accepts for 1 seat (exactly 1 accepted), and one user racing to join
two teams (lands in exactly one) - against a real Postgres, in CI.

## Idempotency

Stripe-style: clients send `Idempotency-Key`; the key row is the lock (first
INSERT wins). Replays get the stored response - including stored 4xxs, so a race
loser's retry returns the same 409 instead of re-running. Same key + different
params is rejected (409 `idempotency_key_reused`). An in-flight key blocks
concurrent duplicates; a stale (>60s) key can be taken over, so a crashed worker
never wedges a retry forever. The UI generates one key per logical action and
keeps it across network retries.

## Security

Email + password signup (bcrypt, cost 10), HS256 JWTs with a 7-day expiry and
an issuer claim; expired, forged, tampered, and wrong-issuer tokens are
rejected (tested). Login and signup are rate limited (10/min/IP) and return an
identical 401 for unknown email vs wrong password, so accounts cannot be
enumerated. Password hashes are never selected into API responses.
Authorization checks happen inside the transaction (leader-only
accept/decline/remove/rotate). Invite codes: 50 bits of entropy (10 chars,
Crockford base32, unambiguous), expiring, rotatable, with per-user fixed-window
rate limits on redemption (10/min) so brute force is infeasible (~10^6 years
at limit). All input validated with zod; all SQL parameterized; browsers never
touch the database directly - reads and writes go through the API only.

## Realtime

Postgres triggers on teams/members/requests/profiles `pg_notify` a single
`board_events` channel; the API holds one LISTEN connection per SSE client and
streams thin change signals over `GET /api/events` (JWT-authenticated). On
every connect and reconnect the server sends a `sync` event and the client
refetches board state, so a change missed during a disconnect is recovered by
resync rather than replay. A 60s refetch interval remains as a safety net;
without an API URL the UI falls back to 15s polling. SSE (not WebSocket) keeps
proxying trivial on Render and works through any Postgres host.

## Performance

Board = 2 indexed queries (partial index on `looking_for_members`), no N+1.
p95 target < 200 ms at 100 concurrent users - measured results and methodology
(geography, warm/cold, repeats) are in `docs/load-test-report.md`.

## Trade-offs

- **Postgres over MongoDB** (organizer's stack): row locks + unique constraints
  make the core invariant enforceable in the data layer; documented and defended.
- **Pessimistic locks over optimistic retries**: under 50:1 oversubscription,
  optimistic concurrency means retry storms; row locks queue losers cleanly.
- **Table-based rate limits over Redis**: one less moving part on free tiers;
  fixed windows are slightly fuzzy at boundaries - acceptable for abuse control.
- **SSE over LISTEN/NOTIFY instead of a hosted realtime service**: portable
  across any Postgres (Neon today, anything tomorrow), no per-message pricing,
  no vendor lock-in. Cost: one DB connection per open stream, fine at
  hackathon scale; events are signals (clients refetch), not full payloads.

## With one more week

Serializable isolation for the few multi-row invariants (removes reliance on
lock discipline), a dedicated read model (materialized board) if 10k users make
the live query hot, outbox + projection for realtime instead of
`postgres_changes` (exact-once delivery), OpenAPI + generated clients, and
per-team locking sharded by advisory locks to compare throughput vs row locks.
