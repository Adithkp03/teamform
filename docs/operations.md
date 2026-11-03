# CrewForge operations runbook

How to watch, alert on, and recover the production deployment. Everything here
uses free tiers only: Vercel Hobby (web + API), Neon free (Postgres), Firebase
Spark (auth), GitHub Actions (CI + health monitor).

## What to watch

| Signal | Where | Healthy | Act when |
| --- | --- | --- | --- |
| API health | `GET /api/health` | `{ok:true, commit:<sha>}` | non-200, or `ok` not true |
| Request rates, errors, latency histograms per route | `GET /api/metrics` (`routes`) | errors ~0, p95 buckets < 200ms band for `/api/board` | error count climbing, latency mass moving up buckets |
| DB pool occupancy | `GET /api/metrics` (`db_pool`) | `waiting` = 0 | `waiting` sustained > 0: pool saturation |
| SSE clients | `GET /api/metrics` (`sse_clients`) | matches expected online users | pinned at cap or stuck climbing (leak) |
| Uptime | `GET /api/metrics` (`uptime_seconds`) | n/a | frequent resets = crash loop or cold-start churn |
| CI + chaos + k6 | GitHub Actions on every push | green | red blocks the push |

Every response carries `x-request-id`; unhandled errors log
`{level:"error", request_id, route, ...}` as JSON. A user report plus its
request id can be tied to one exact failing request in Vercel logs.

## Alerting (free tier)

`.github/workflows/health-monitor.yml` pings `/api/health`, `/api/metrics` and
the web app every 15 minutes. The alert itself is GitHub's NATIVE Actions
failure notification to the repo owner - the workflow sends nothing itself,
introduces no third party, and only reads public endpoints. If the owner's
GitHub notification settings silence Actions mail, no alert goes out; check
Settings -> Notifications. GitHub can delay scheduled runs, so treat this as
best-effort detection on top of the dashboards, not a paging SLA.

## Dashboards that already exist

- Vercel project dashboard: invocations, errors, function logs per deployment.
- Neon console: connection count, CPU, storage, query history.
- Firebase console: sign-in methods, users, quota usage.

## Incident recipes

**API 5xx or health red.** Check Vercel function logs for the request id. If a
bad deploy: Vercel dashboard -> Deployments -> previous deployment ->
"Redeploy" / "Promote to production". Rollback is instant; no data change.

**Database unreachable.** Neon console -> project status. Free tier suspends
idle computes; first request after idle pays a cold start (seconds). If data
corruption is suspected, Neon branches give point-in-time recovery: create a
branch from before the incident and point a recovery deployment at it.

**DB pool saturation (`db_pool.waiting` climbing).** Each serverless instance
holds at most `PG_POOL_MAX` (default 5) connections. Reduce concurrency per
instance, or raise Neon's connection limit by moving off free tier. Never
raise `PG_POOL_MAX` past what Neon allows: the failure just moves.

**SSE stalled but API fine.** Check `sse_clients` vs expectations. Poll-mode
streams live at most 280s by design (Vercel function cap); clients reconnect
with their cursor and refetch on `sync`. A stuck dispatcher recovers at the
next interval; persistent stall means checking the `domain_events` dispatch
query in logs.

**Firebase outage.** Sign-in and token rotation return 503
`firebase_unavailable` with NO session state change (retry-safe by design);
existing access tokens work out their 15-minute TTL. Nothing to do but wait;
sessions resume rotating when Google recovers.

**Suspected token theft / replay.** Rotation replay detection revokes the
whole session family automatically (401 on the replayed token). Password
reset revokes every family at its next rotation.

## Audit retention and export

`audit_log` rows are never deleted by application flows (team deletion keeps
the trail). Retention is a MANUAL policy, not an automation: nothing deletes
audit rows automatically. Keep them for the life of the event plus 90 days,
export to CSV (`GET /api/organizer/audit/export`) for archive, then clean up
by hand if storage matters.

**Operational retention sweep.** Growing operational tables are pruned by
`POST /api/organizer/retention/sweep` (organizer-only, rate-limited). The body
is `{ "dry_run": true }` by DEFAULT - a bare POST only counts; pass
`{ "dry_run": false }` to delete. It prunes: rate-limit windows closed >2h,
idempotency records >24h, refresh tokens expired >7d, action tokens
expired/used >1d, dispatched domain events >7d (past the SSE replay window),
suggestion impressions >30d, metric rollups >14d. Every real sweep writes an
audited `retention_sweep` entry with per-table counts; the response includes
`last_swept_at` so the policy is performed AND tracked. Run it weekly during
an event. `audit_log` and live user/team data are never touched by the sweep.
Suggestion impressions also self-prune to a rolling 30-day window
(probabilistic delete on ~2% of serves) as a backstop. Organizers search the log via `GET /api/organizer/audit` including
for deleted teams, and resolve stuck join requests via
`/api/organizer/requests/stuck` + `/resolve` (cancel-with-reason only; seat
invariants are never overridden by operators).

## Upgrade path (when the event is real)

1. Neon paid tier for connection headroom and PITR windows.
2. Vercel Pro for longer function limits (enables true push SSE) and log
   drains into a real alerting tool.
3. Transactional email with an owned domain for verification/reset delivery
   (Firebase's free quotas cover 1000 verifications/day meanwhile).
4. Multi-event support: the schema keys everything by hackathon already; the
   product surface is single-event by deliberate scope.
