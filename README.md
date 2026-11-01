# TeamForm - race-proof team formation at scale

Hack4Hack Crew Hiring Challenge 2026, PS1. A production-grade team-formation
service for a 10,000-participant hackathon: teams with expiring invite codes,
leader-approved join requests, a live "looking for teammates" board, and
correctness proven under concurrency.

## Stack

- **API**: Node 22 + Fastify (TypeScript), stateless; runs locally, in Docker, or on Render (free tier, no card)
- **Database**: PostgreSQL 16 (Neon serverless free tier in production, Docker locally) - the correctness backbone
- **Realtime**: Server-sent events over Postgres LISTEN/NOTIFY (portable, no vendor lock-in), with resync-on-reconnect and a 60s polling safety net
- **Web**: React 18 + Vite + Tailwind; mobile-first, fully keyboard-operable
- **Tests**: Vitest against a real Postgres (54 tests: 50-way race, idempotency, auth/JWT hardening, SSE push)
- **Load test**: k6 (target: p95 < 200 ms on `GET /api/board` at 100 concurrent users)

## Quick start (one command)

```bash
docker compose up --build
# web: http://localhost:5173  api: http://localhost:3000
```

## Local dev without Docker

```bash
# needs a Postgres at DATABASE_URL (see .env.example)
npm install
npm run migrate
npm run seed          # 10,000 users + 2,000 teams (or: node db/seed.mjs 100 20)
npm run dev           # API on :3000, ALLOW_DEV_LOGIN=true in .env
npm run dev -w @teamform/web   # web on :5173
```

## Tests

```bash
npm test              # 34 API tests: rules, authz, validation, idempotency,
                      # and concurrency proofs (50 racers, 1 seat, exactly 1 winner)
```

## Chaos test (bonus)

```bash
npm run chaos         # storms joins, KILLS the API mid-flight, then proves
                      # every DB invariant still holds (scripts/check-invariants.mjs)
```

## Load test

See `loadtest/board.k6.js` and `.github/workflows/loadtest.yml`. The measured
report lives in `docs/load-test-report.md`.

## Docs

- `docs/design.md` - 1-page design doc: data model, race prevention, trade-offs
- `docs/research.md` - the literature and real-world failure modes behind the design
- `docs/load-test-report.md` - measured latency, with methodology and caveats
