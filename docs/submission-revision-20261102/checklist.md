# TeamForm - submission requirement check
Adith K P · 3 Nov 2026 · Firebase-auth edition · supersedes checklist v9

**Public repo:** https://github.com/Adithkp03/teamform  
**Live app:** https://teamform-web.vercel.app  
**API health:** https://teamform-api.vercel.app/api/health

## Implemented and tested
- **Team rules:** min/max size; forming state; one team per person enforced by database uniqueness; expiring/rotatable invite code; leader transfer on departure; final member departure deletes the team.
- **Race proof:** 50 concurrent joins for 1 remaining seat: 1 success, 49 clean 409s, checked final count 4. Eight concurrency tests also cover concurrent accepts, two-team races, idempotent retries and leader departure.
- **Leader decisions:** server-side accept/decline/remove permissions, locked nonpending-request rejection, actor/subject audit history. UI alone is not the permission boundary.
- **Auth/identity:** Firebase Authentication (Spark, no card) with server-side Google verification of every ID token, `email_verified` enforced server-side, uid-bound encrypted Firebase-refresh-token storage for revocation at rotation, legacy bcrypt sign-in retained, and legacy claim gated on password/session plus verified Firebase identity. Dev login fails the deploy loudly if ever enabled in production; the stray production env flag was removed and probed 404.
- **Retries:** exact keyed routes are create-team, join-by-code, create-request and rotate-invite. Accept/decline are locked state transitions, leave/remove retry-safe deletes, profile last-write-wins.
- **Live board/team:** SSE plus shared ~1s poller in production; production two-browser observations documented in the requirement audit. Not a latency guarantee.
- **Suggestions:** grounded per-candidate reasons from the same stored fields the score uses; displayed timezone reconciled with scoring offset at write time, so reasons cannot contradict the card.
- **Board:** server-side search + skill/timezone/capacity/looking filters persistent through cursor pagination; min-open-seats filter; 24-card pages; truncated counts say 24+.
- **Onboarding:** first-run checklist on the board (complete profile, join/create, suggestions) driven by the server profile/team state.
- **UI:** light blue/white theme, responsive navigation/cards, labeled forms, visible focus, 44px touch targets. 320/390px widths, 200% browser zoom, and keyboard-only full flow covered by specs. Profile Save waits for initial load; failed form input is preserved with inline errors.
- **Verification:** 120 API tests / 9 files on a fresh migration-only DB, 10 browser tests; axe scan reports no serious/critical violations on scanned pages. Chaos is 1 crash-recovery drill / 6 invariants, not 6 tests.

## Scale evidence: keep the labels
10,000 synthetic profiles/2,000 teams is a dataset size, **not 10,000 simultaneous users**. Board workload 100 readers; mixed 99 readers + 4 paced mutators. Local full-seed board p95 138-140ms, 0 failures. Historical CI pairs (board p95 / mixed p95): `35f54a6` 74.13/206.47 (**mixed FAILED**); identical app `0d0b5aa` 23.06/36.20 (pass); `3868857` 40.62/47.28 (pass). Run links and raw measurements: `docs/load-test-report.md`. Sample variability cause unproven.

## Current revision checks and deliverables
Deployed app commit `9f683ea`: hosted CI test, e2e, chaos and k6 load all passed on that SHA (runs 41511777781, 41511777767, 41511777766, 41511777921); production health reports it. Migration 0010 (`firebase_uid` + unique index) applied to production and proven on a fresh migration-only database. Walkthrough video v9 (3m08s) supersedes v8; earlier editions retained.

## Open limits: do not call these done
- **One owner-verified real-inbox email receipt pending.** Firebase sends verification/reset mail; the exchange is proven against real Google-signed tokens, but end-to-end inbox receipt is owner-verified post-deploy. Free-tier mail can land in spam.
- **Full legacy->Firebase claim with a verified identity is verified up to the email gate on production** (unverified identity refused 403; legacy sign-in and session proven with a synthetic account, cleaned up); the completed verified claim awaits the same real inbox.
- **Production p95 unmeasured.** No production load testing; Vercel Hobby policy/caps still apply.
- Single-hackathon deployment; enrollment/multi-event scope is future work.
- Free tiers only; no card or organizer submission.

Latest verified load workflow on the deployed SHA: https://github.com/Adithkp03/teamform/actions/runs/41511777921
