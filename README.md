# TeamForm - race-proof team formation at scale

Hack4Hack Crew Hiring Challenge 2026, PS1. A team-formation
service for a 10,000-participant hackathon: teams with expiring invite codes,
leader-approved join requests, a live "looking for teammates" board, and
correctness proven under concurrency.

## Stack

- **API**: Node 22 + Fastify (TypeScript), stateless; deployed as a Vercel serverless bundle; also runs locally or in Docker
- **Database**: PostgreSQL 16 (Neon serverless free tier in production, Docker locally) - the correctness backbone
- **Realtime**: Server-sent events backed by a durable Postgres outbox, polled about once per second in the serverless deployment; optional LISTEN/NOTIFY mode for self-hosted processes; resync on reconnect
- **Web**: React 18 + Vite + Tailwind; mobile-first, fully keyboard-operable
- **Tests**: 99 API tests against real Postgres, 5 browser tests (flows, realtime, keyboard and axe), plus one crash-recovery drill checking 6 database invariants
- **Load test**: k6 (target: p95 < 200 ms on `GET /api/board` at 100 concurrent users)

## Current deployment and evidence

Live app: https://teamform-web.vercel.app

Verification/password-reset email delivery is not configured. Mailjet closed the new account during setup; no working provider is claimed.

Historical CI results are preserved with their original tested source IDs. See `docs/history/` for the pre-publication token cleanup and old-to-new commit mapping. On sanitized/provenance commit `35f54a6`, CI, E2E and Chaos passed, but the mixed-load read p95 was **206.47ms**, missing the unchanged **<200ms** threshold. All 114,816 checks passed and no HTTP request failed in that mixed run. This does not establish repeatable mixed-load latency below 200ms. See `docs/load-test-report.md` for the exact run and historical benchmark pair.

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
npm test              # 99 API tests: rules, authz, validation, idempotency,
                      # and concurrency proofs (50 racers, 1 seat, exactly 1 winner)
```

## Chaos test (bonus)

```bash
npm run chaos         # storms joins, KILLS the API mid-flight, then proves
                      # six checked DB invariants hold (scripts/check-invariants.mjs)
```

## Load test

See `loadtest/board.k6.js` and `.github/workflows/loadtest.yml`. The measured
report lives in `docs/load-test-report.md`.

## Docs

- `docs/design.md` - 1-page design doc: data model, race prevention, trade-offs
- `docs/research.md` - the literature and real-world failure modes behind the design
- `docs/load-test-report.md` - measured latency, with methodology and caveats
