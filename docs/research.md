# Research: why team formation breaks, and what this design does about it

How each source maps to a concrete design decision in this repo.

## Academic / formal grounding

**Berenson, Bernstein, Gray, Melton, O'Neil, O'Neil - "A Critique of ANSI SQL
Isolation Levels" (SIGMOD 1995).** The canonical taxonomy of concurrency
anomalies (dirty/non-repeatable/phantom reads, and anomalies the SQL standard's
phenomena miss, like write skew). Relevance: the "50 people join a team with 1
seat" bug is a check-then-act anomaly under READ COMMITTED - two transactions
both read `count = 3 < 4`, both insert. Our fix is not a stronger global
isolation level (which would still need application retry loops) but explicit
row locks (`SELECT ... FOR UPDATE`) that serialize the check and the insert, the
pattern Berenson et al. describe as cursor stability / locking out the anomaly.
Source: https://www.microsoft.com/en-us/research/publication/a-critique-of-ansi-sql-isolation-levels/

**Martin Kleppmann - "Hermitage: Testing the I in ACID" (2014) and Designing
Data-Intensive Applications (2017).** Hermitage measures which anomalies real
databases actually allow at each isolation level; Postgres at READ COMMITTED
permits exactly the lost-update/write-skew anomalies that break seat counting.
DDIA's treatment of "preventing lost updates" (atomic writes, explicit locking,
auto-detect) is the menu we chose explicit locking from.
Sources: https://github.com/ept/hermitage , https://dataintensive.net/

**PostgreSQL documentation, "Explicit Locking" (13.3).** Semantics of
`FOR UPDATE`: waiting transactions block until the holder commits, then re-read
the updated row - which is why our losers see the winner's committed count and
fail cleanly instead of erroring. Also documents why you must lock consistently
(same order) to avoid deadlock - we always lock request-then-team in one order.
Source: https://www.postgresql.org/docs/current/explicit-locking.html

## Industry patterns we adopted

**Stripe - idempotent requests (API design + engineering blog) and Brandur
Leach's "Implementing Stripe-like idempotency keys in Postgres".** Our
`idempotency_keys` table follows this directly: the key row is the lock, the
stored response (including errors) is replayed, parameter mismatch is rejected,
in-flight keys block duplicates, stale keys can be recovered. This is the
difference between "disable the button" (client-side, breaks on flaky networks)
and actual exactly-once effect.
Sources: https://docs.stripe.com/api/idempotent_requests , https://stripe.com/blog/idempotency , https://www.brandur.org/idempotency-keys

**High-concurrency ticketing/booking designs (Ticketmaster-style seat holds).**
The established pattern for "N people, 1 seat": lock the scarce resource row,
check, mutate, commit in one transaction; return 409 to losers. Pessimistic
locking is chosen over optimistic compare-and-set specifically when
oversubscription is high (50:1 here), because optimistic losers retry and
amplify contention - a retry storm.
Sources: https://systemdesignatlas.dev/docs/11-ticketmaster-booking , https://williammuli.dev/writing/locks-vs-optimistic-concurrency/ , https://pgquest.dev/lessons/concurrency-reservation-system

## Demonstrated failures in current systems (verified)

**LiteLLM issue #25951 (open, April 2026): race condition in `/team/member_add`.**
Concurrent requests to add team members silently lose members: the code does
read-modify-write on a JSON member list with no lock or transaction; 5
concurrent adds persist only 1-2, and the API returns 200 for all of them. This
is the *same feature* as our join-by-code, broken in production, in a widely
used project. Our equivalent path is lock-serialized and the race test proves
the count never diverges. https://github.com/BerriAI/litellm/issues/25951

**FOSS United PR #1438 (merged, Feb 2026): "disable button when api fetch is
loading" on their hackathon platform.** A real hackathon platform mitigating
double-submits by disabling buttons - the client-side half-fix. It stops
double-clicks but not retries after timeouts, double taps on mobile, or two
tabs. Our server-side idempotency keys cover all of those; the UI also keeps a
stable key per logical action across retries.
https://github.com/fossunited/fossunited/pull/1438

**Race-condition exploit write-ups (e.g. free-plan feature abuse via parallel
requests).** Demonstrate that "check then act" endpoints are not just buggy but
exploitable: attackers deliberately fire parallel requests to defeat limits.
This motivates enforcing every limit (seat cap, one-team-per-person) inside the
locked transaction AND as a unique constraint - not in application reads that
can be raced.
https://medium.com/@rawansa3ed2002/race-condition-exploit-enables-free-plan-users-to-access-premium-features-9619d0fa0a53

## Platform constraints verified for the deployment design

- **Vercel cannot hold WebSocket connections for serverless functions** (docs
  and community confirmation conflict on Fluid-compute beta; the safe reading
  for a free-tier submission is: no persistent sockets) - hence Supabase
  Realtime for push + polling fallback.
  https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
  https://community.vercel.com/t/does-vercel-support-websockets-now-that-we-have-fluid-compute/27205
- **Supabase free tier**: 500 MB database, projects pause after 1 week of
  inactivity, Realtime included; operational implications documented for the
  review window. https://supabase.com/pricing , https://supabase.com/docs/guides/realtime/limits
