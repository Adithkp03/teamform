# TeamForm - submission requirement check
Adith K P · 2 Nov 2026 · revised light-mode edition · supersedes checklistv 8

**Public repo:** https://github.com/Adithkp03/teamform  
**Live app:** https://teamform-web.vercel.app  
**API health:** https://teamform-api.vercel.app/api/health

## Implemented and tested
- **Team rules:** min/max size; forming state; one team per person enforced by database uniqueness; expiring/rotatable invite code; leader transfer on departure; final member departure deletes the team.
- **Race proof:**50 concurrent joins for 1 remaining seat:1 success,49 clean 409 s, checked final count 4. Eight concurrency tests also cover concurrent accepts, two-team races, idempotent retries and leader departure.
- **Leader decisions:** server-side accept/decline/remove permissions, locked nonpending-request rejection, actor/subject audit history. UI alone is not the permission boundary.
- **Retries:** exact keyed routes are create-team, join-by-code, create-request and rotate-invite. Accept/decline are locked state transitions, leave/remove retry-safe deletes, profile last-write-wins.
- **Live board/team:** SSE plus shared~1 spoller in production; previous production two-browser observations documented in requirement audit. New light-UI video shows two separate sessions on isolated local stack. Neither is a latency guarantee.
- **Auth/security:** bcrypt,15 min JWT, hashed opaque family-rotated refresh tokens,30 dayabsolute family lifetime, fixed 10 sgrace with liveness checks, logout/reset/replay revocation, origin-pinned CORS, validation and rate limits. Residual grace-window parallel bearers documented.
- **Suggestions:** complementary/shared skills and timezone score components visible. No unvalidated claims about match quality.
- **Board:** independent cursor pagination implemented,24 cardpages, truncated counts say 24+. Search is loaded-results-only. Final null cursor no longer reuses a stale cursor.
- **UI:** light blue/white theme, responsive navigation/cards, labeled forms, visible focus,44 pxtouch targets.320/390 pxwidth and keyboard-only full flow checked. Profile Save waits for initial load.
- **Verification:**103 API tests/8 files,6 local browser tests; axe scan reports no serious/critical violations on scanned pages. Chaos is 1 crash-recovery drill/6 invariants, not 6 tests. Rechecks are scoped, not an unlimited guarantee.

## Scale evidence: keep the labels
10,000 synthetic profiles/2,000 teams is a dataset size, **not 10,000 simultaneous users**. Board workload 100 readers; mixed 99 readers+4 paced mutators. Isolated full-seed CI pairs below are boardp95/mixed-readp95:

| Tested commit | p95 (ms) | Outcome and observed source |
|---|---|---|
|35f54a6|74.13 /206.47|Mixed threshold FAILED; run 41403853587|
|0d0b5aa|23.06 /36.20|Passed, identical app to previous run;41404383482|
|3868857|40.62 /47.28|Passed;41405128834. Not proof optimization caused speedup.|
|d5c913e|No borrowed metric|Docs-only pass;41405650692. Own metrics not substituted.|

Run links and raw measurements: `docs/load-test-report.md` in the public repo. Earlier misses remain. Sample variability cause is unproven. Local duplicate-query optimization reduced 100 cold-reader queries 200 to 2 on a small diagnostic dataset; that is not a full-seed or production claim.

## Current revision checks and deliverables
UI change 8dc8713:CI/API and chaos passed; hosted E2E 5 passed/1 failed due screenshot path `/downloads` absent on runner. Follow-up 2df081d changes paths only; CI, E2E (6 tests), chaos and load passed on that SHA. Production health matches it. Public repo is already authorized and live, not pending visibility. Updated designPDF and race-first walkthrough supersede earlier editions, which are retained.

## Open limits: do not call these done
- **Real verification/reset email delivery disabled.** Local token/outbox tests are not external delivery. No durable delivery queue or 10k mail simulation built. New provider setup paused; no paid sender/domain purchase approved.
- **Production p95 unmeasured.** No production load testing; Vercel Hobby policy/caps still apply. Isolated results are not a hosted throughput guarantee.
- Single-hackathon deployment; enrollment/multi-event scope is future work. Cursor pagination is not future work.
- Free tiers only; caps/grace trade-off disclosed. No card or organizer submission. Open items stay open.

Latest verified load workflow: https://github.com/Adithkp03/teamform/actions/runs/41407249950 (2df081d, passed; no earlier metric substituted).
