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
- **Tests**: 172 API tests against real Postgres, 13 browser tests (flows, realtime, keyboard, axe + ARIA-semantics assertions incl. a 390px pass (not VoiceOver/TalkBack), zoom, onboarding, edge data), plus one crash-recovery drill checking 6 database invariants
- **Load test**: k6 (target: p95 < 200 ms on `GET /api/board` at 100 concurrent users)

## Current deployment and evidence

Live app: https://teamform-web.vercel.app

Authentication moved to Firebase Authentication (Spark free tier, no card): email/password sign-in runs client-side through Firebase, which sends the real verification and password-reset emails, and the client exchanges the Firebase ID token + refresh token at `POST /api/auth/firebase` for the app's short-lived JWT + refresh-token session family. The exchange verifies the ID token against Google server-side, requires `email_verified: true` in the verified token, and binds the presented Firebase refresh token to the same uid before storing it (encrypted) for revocation checks at rotation. Legacy bcrypt accounts keep working through `/api/auth/login`; claiming one into a Firebase identity requires the legacy password or an existing authenticated legacy session plus the verified Firebase identity - email equality alone transfers nothing. End-to-end delivery to a real inbox is verified by the owner post-deploy; free-tier mail can land in spam.

Historical CI results are preserved with their original tested source IDs. See `docs/history/` for the pre-publication token cleanup and old-to-new commit mapping. On sanitized/provenance commit `35f54a6`, CI, E2E and Chaos passed, but the mixed-load read p95 was **206.47ms**, missing the unchanged **<200ms** threshold. All 114,816 checks passed and no HTTP request failed in that mixed run. This does not establish repeatable mixed-load latency below 200ms. See `docs/load-test-report.md` for the exact run and historical benchmark pair. A later sample on `3868857` passed with board p95 40.62ms and mixed read p95 47.28ms; 103 API tests, five browser tests and the crash-recovery drill passed. These are isolated-CI results, not production throughput or proof that the earlier variation is explained.

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
npm test              # 172 API tests: rules, authz, validation, idempotency
                      # (incl. response-loss replay + stale-worker takeover),
                      # firebase exchange/claim, organizer operations, user
                      # journeys, and concurrency proofs
                      # (50 racers, 1 seat, exactly 1 winner)
```

## Organizer operations

Allowlisted organizers (`ORGANIZER_EMAILS`, unset = nobody, fail closed) get
operations tooling under `/api/organizer/*`: event settings with an audited
before/after and an over-cap report, full audit search + CSV export that
survives team deletion, stuck/disputed join-request resolution
(cancel-with-reason only; seat invariants are never operator-overridden), and
matching-quality metrics built from suggestion impressions and direct
usefulness votes. Retention/export policy and incident recipes:
`docs/operations.md`. Production alerting: a scheduled GitHub Actions health
monitor pings the live API + web every 15 minutes; GitHub's native Actions
failure notification emails the repo owner (the workflow itself sends
nothing and touches only public endpoints).

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

### Light-mode UX revision (2 Nov 2026)
Blue/white interface inspired by hackathon-platform information hierarchy, without copied branding. Desktop board discovery + side actions; phone actions move above the long results list. Search is explicitly **loaded-results only**, not a server-wide search. Cursor end-of-list handling is regression-tested. Profile Save waits for initial load. Local verification: 118 API tests and 10 browser tests (keyboard, two-session realtime, accessibility, 200% zoom, 320/390px layout, onboarding checklist, edge data). Firebase email delivery is configured; real-inbox receipt is owner-verified. Public repo; revised PDFs/video supersede earlier stale-status editions without deleting them.
