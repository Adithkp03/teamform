import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { requireOrganizer } from '../auth.js';
import { parse } from '../util.js';
import { errors } from '../errors.js';
import { rateLimit } from '../ratelimit.js';

/**
 * Organizer operations. Every endpoint requires requireOrganizer (allowlisted
 * profile emails via ORGANIZER_EMAILS; unset = nobody, fail closed).
 *
 * Scope is deliberately operations tooling, not superuser impersonation:
 *   - event settings (team sizes, invite TTL) for the current hackathon
 *   - audit search + CSV export across the WHOLE event, including teams that
 *     were later deleted (audit_log rows are never cascade-deleted)
 *   - stuck/disputed join-request resolution (cancel with an audited reason;
 *     force-accept is NOT offered - seat invariants are never overridden)
 *   - matching-quality metrics from suggestion impressions + feedback
 *
 * Audit retention: audit_log rows are kept for the life of the event and are
 * exportable at any time; the retention/export contract is documented in
 * docs/operations.md.
 */

const uuidParam = z.string().uuid();

const auditQuerySchema = z.object({
  action: z.string().trim().max(80).optional(),
  team_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

function auditWhere(q: z.infer<typeof auditQuerySchema>) {
  // Audit rows double as the participant-support trail: metadata.user_id is
  // the subject of the action (requester, removed member, ...).
  const clauses: string[] = [
    `($1::text IS NULL OR a.action = $1)`,
    `($2::uuid IS NULL OR a.team_id = $2)`,
    `($3::uuid IS NULL OR a.actor_id = $3 OR a.metadata->>'user_id' = $3::text)`,
    `($4::timestamptz IS NULL OR a.created_at >= $4)`,
    `($5::timestamptz IS NULL OR a.created_at <= $5)`,
    `($6::bigint IS NULL OR a.id < $6)`,
  ];
  const params = [q.action ?? null, q.team_id ?? null, q.user_id ?? null, q.since ?? null, q.until ?? null, q.cursor ?? null];
  return { where: clauses.join(' AND '), params };
}

const AUDIT_SELECT = `
  SELECT a.id, a.action, a.created_at, a.team_id, a.metadata,
         ap.display_name AS actor_name, tp.name AS team_name,
         sp.display_name AS subject_name
  FROM audit_log a
  LEFT JOIN profiles ap ON ap.id = a.actor_id
  LEFT JOIN teams tp ON tp.id = a.team_id
  LEFT JOIN profiles sp ON sp.id = NULLIF(a.metadata->>'user_id', '')::uuid`;

const eventSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  team_size_min: z.number().int().min(1).max(20).optional(),
  team_size_max: z.number().int().min(1).max(50).optional(),
  invite_code_ttl_minutes: z.number().int().min(10).max(43200).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one setting is required' });

export default async function organizerRoutes(app: FastifyInstance) {
  const pre = { preHandler: requireOrganizer };

  async function currentHackathon() {
    const { rows } = await pool.query(`SELECT * FROM hackathons ORDER BY created_at DESC LIMIT 1`);
    if (!rows.length) throw errors.notFound('No hackathon configured');
    return rows[0];
  }

  // ---- Event overview: the operations landing numbers ----
  app.get('/api/organizer/overview', pre, async (req: any) => {
    await rateLimit(`org:${req.userId}`, 60, 60);
    const h = await currentHackathon();
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM profiles WHERE NOT is_seed) AS participants,
         (SELECT count(*)::int FROM profiles WHERE is_seed) AS seed_profiles,
         (SELECT count(*)::int FROM teams WHERE hackathon_id = $1) AS teams,
         (SELECT count(*)::int FROM teams WHERE hackathon_id = $1 AND looking_for_members) AS teams_looking,
         (SELECT count(*)::int FROM team_members WHERE hackathon_id = $1) AS memberships,
         (SELECT count(*)::int FROM join_requests WHERE hackathon_id = $1 AND status = 'pending') AS pending_requests,
         (SELECT count(*)::int FROM join_requests WHERE hackathon_id = $1 AND status = 'pending' AND created_at < now() - interval '24 hours') AS stuck_requests_24h,
         (SELECT count(*)::int FROM audit_log WHERE hackathon_id = $1 OR hackathon_id IS NULL) AS audit_rows,
         (SELECT max(created_at) FROM audit_log WHERE action = 'retention_sweep') AS last_swept_at`,
      [h.id],
    );
    return { event: { slug: h.slug, name: h.name, team_size_min: h.team_size_min, team_size_max: h.team_size_max, invite_code_ttl_minutes: h.invite_code_ttl_minutes }, ...rows[0] };
  });

  // ---- Event settings (audited, with a safety report) ----
  app.get('/api/organizer/event', pre, async () => {
    const h = await currentHackathon();
    return { event: h };
  });

  app.put('/api/organizer/event', pre, async (req: any) => {
    await rateLimit(`org:${req.userId}`, 20, 60);
    const body = parse(eventSettingsSchema, req.body);
    return withTx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM hackathons ORDER BY created_at DESC LIMIT 1 FOR UPDATE`);
      if (!rows.length) throw errors.notFound('No hackathon configured');
      const before = rows[0];
      const nextMin = body.team_size_min ?? before.team_size_min;
      const nextMax = body.team_size_max ?? before.team_size_max;
      if (nextMax < nextMin) throw errors.badRequest('team_size_max must be >= team_size_min');
      const updated = await c.query(
        `UPDATE hackathons SET name = $2, team_size_min = $3, team_size_max = $4, invite_code_ttl_minutes = $5
         WHERE id = $1 RETURNING *`,
        [before.id, body.name ?? before.name, nextMin, nextMax, body.invite_code_ttl_minutes ?? before.invite_code_ttl_minutes],
      );
      // Lowering the cap does not shrink existing teams; report how many now
      // sit above it so the organizer can act instead of discovering later.
      const over = await c.query(
        `SELECT count(*)::int AS n FROM teams WHERE hackathon_id = $1 AND member_count > $2`,
        [before.id, nextMax],
      );
      await c.query(
        `INSERT INTO audit_log (hackathon_id, actor_id, action, metadata) VALUES ($1, $2, 'event_settings_updated', $3)`,
        [before.id, req.userId, JSON.stringify({
          before: { name: before.name, team_size_min: before.team_size_min, team_size_max: before.team_size_max, invite_code_ttl_minutes: before.invite_code_ttl_minutes },
          after: { name: updated.rows[0].name, team_size_min: nextMin, team_size_max: nextMax, invite_code_ttl_minutes: updated.rows[0].invite_code_ttl_minutes },
          teams_over_max: over.rows[0].n,
        })],
      );
      return { event: updated.rows[0], teams_over_max: over.rows[0].n };
    });
  });

  // ---- Audit search (keyset-paginated; survives team deletion) ----
  app.get('/api/organizer/audit', pre, async (req: any) => {
    await rateLimit(`org:${req.userId}`, 60, 60);
    const q = parse(auditQuerySchema, req.query ?? {});
    const { where, params } = auditWhere(q);
    const { rows } = await pool.query(
      `${AUDIT_SELECT} WHERE ${where} ORDER BY a.id DESC LIMIT $7`,
      [...params, q.limit],
    );
    const last = rows[rows.length - 1];
    return { audit: rows, next_cursor: rows.length === q.limit && last ? last.id : null };
  });

  // ---- Audit CSV export (same filters; capped at 10k rows per export) ----
  app.get('/api/organizer/audit/export', pre, async (req: any, reply) => {
    await rateLimit(`org:${req.userId}`, 10, 60);
    const q = parse(auditQuerySchema.omit({ cursor: true }).extend({ limit: z.coerce.number().int().min(1).max(10000).default(10000) }), req.query ?? {});
    const { where, params } = auditWhere({ ...q, cursor: undefined });
    const { rows } = await pool.query(
      `${AUDIT_SELECT} WHERE ${where} ORDER BY a.id DESC LIMIT $7`,
      [...params, q.limit],
    );
    const esc = (v: unknown) => {
      const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'id,created_at,action,actor_name,subject_name,team_name,team_id,metadata';
    const lines = rows.map((r: any) =>
      [r.id, new Date(r.created_at).toISOString(), r.action, r.actor_name, r.subject_name, r.team_name, r.team_id, r.metadata].map(esc).join(','));
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="teamform-audit-${Date.now()}.csv"`);
    return [header, ...lines].join('\n') + '\n';
  });

  // ---- Stuck / disputed requests ----
  app.get('/api/organizer/requests/stuck', pre, async (req: any) => {
    await rateLimit(`org:${req.userId}`, 60, 60);
    const q = parse(z.object({ older_than_hours: z.coerce.number().min(1).max(720).default(24), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query ?? {});
    const { rows } = await pool.query(
      `SELECT jr.id, jr.created_at, jr.message, jr.status,
              p.display_name AS requester_name, p.email AS requester_email,
              t.name AS team_name, t.id AS team_id, t.member_count,
              lp.display_name AS leader_name
       FROM join_requests jr
       JOIN profiles p ON p.id = jr.user_id
       JOIN teams t ON t.id = jr.team_id
       JOIN profiles lp ON lp.id = t.leader_id
       WHERE jr.status = 'pending' AND jr.created_at < now() - make_interval(hours => $1::int)
       ORDER BY jr.created_at ASC LIMIT $2`,
      [q.older_than_hours, q.limit],
    );
    return { stuck: rows, older_than_hours: q.older_than_hours };
  });

  // Resolve a stuck/disputed request by cancelling it with an audited reason.
  // Accept is deliberately absent: seat invariants belong to the race-proofed
  // join path, never to an operator override.
  app.post('/api/organizer/requests/:id/resolve', pre, async (req: any) => {
    await rateLimit(`org:${req.userId}`, 30, 60);
    parse(uuidParam, req.params.id);
    const body = parse(z.object({ reason: z.string().trim().min(1).max(300) }), req.body);
    return withTx(async (c) => {
      const { rows } = await c.query(
        `SELECT jr.*, t.name AS team_name FROM join_requests jr JOIN teams t ON t.id = jr.team_id
         WHERE jr.id = $1 FOR UPDATE OF jr`,
        [req.params.id],
      );
      const jr = rows[0];
      if (!jr) throw errors.notFound('Request not found');
      if (jr.status !== 'pending') throw errors.conflict('request_already_decided', `Request is already ${jr.status}`);
      await c.query(
        `UPDATE join_requests SET status = 'cancelled', decided_at = now(), decided_by = $2 WHERE id = $1`,
        [jr.id, req.userId],
      );
      await c.query(
        `INSERT INTO audit_log (hackathon_id, team_id, actor_id, action, metadata) VALUES ($1, $2, $3, 'organizer_request_cancelled', $4)`,
        [jr.hackathon_id, jr.team_id, req.userId, JSON.stringify({ request_id: jr.id, user_id: jr.user_id, reason: body.reason, team_name: jr.team_name })],
      );
      return { ok: true, request_id: jr.id, status: 'cancelled' };
    });
  });

  // ---- Matching quality: impressions, outcome proxy, direct feedback ----
  app.get('/api/organizer/matching', pre, async (req: any) => {
    await rateLimit(`org:${req.userId}`, 30, 60);
    const { rows } = await pool.query(
      `WITH first_impressions AS (
         SELECT DISTINCT ON (user_id, candidate_id) user_id, candidate_id, created_at
         FROM suggestion_impressions ORDER BY user_id, candidate_id, created_at
       ),
       -- Audit-derived join moments. team_members rows are deleted on leave,
       -- so current membership can never prove historic pair formation; the
       -- audit trail survives leaves and deletions and carries the event
       -- timestamps. member_joined via join_request names the joiner in
       -- metadata.user_id (the actor is the accepting leader).
       join_events AS (
         SELECT COALESCE(NULLIF(metadata->>'user_id', '')::uuid, actor_id) AS user_id,
                team_id, created_at
         FROM audit_log
         WHERE action IN ('team_created', 'member_joined') AND team_id IS NOT NULL
       ),
       outcomes AS (
         SELECT fi.user_id, fi.candidate_id,
           EXISTS (
             SELECT 1 FROM join_events a JOIN join_events b ON a.team_id = b.team_id
             WHERE a.user_id = fi.user_id AND b.user_id = fi.candidate_id
               AND a.created_at BETWEEN fi.created_at AND fi.created_at + interval '7 days'
               AND b.created_at BETWEEN fi.created_at AND fi.created_at + interval '7 days'
           ) AS pair_formed_within_7d
         FROM first_impressions fi
       )
       SELECT
         (SELECT count(*)::int FROM suggestion_impressions) AS impressions,
         (SELECT count(DISTINCT user_id)::int FROM suggestion_impressions) AS users_served,
         (SELECT count(DISTINCT candidate_id)::int FROM suggestion_impressions) AS candidates_served,
         (SELECT count(*)::int FROM outcomes) AS unique_pairs,
         (SELECT count(*)::int FROM outcomes WHERE pair_formed_within_7d) AS pair_formed_within_7d,
         (SELECT count(*)::int FROM suggestion_feedback) AS feedback_votes,
         (SELECT count(*)::int FROM suggestion_feedback WHERE useful) AS feedback_useful`,
    );
    return {
      ...rows[0],
      // Honesty contract: pair_formed_within_7d counts served pairs where BOTH
      // viewer and candidate provably joined the SAME team after the
      // impression, within 7 days, from audit event timestamps (immune to
      // later leave/delete churn; already-teammates and pre-impression joins
      // are excluded by the timestamp window). It proves the pair formed -
      // not that the suggestion caused it; correlation, not attribution.
      note: 'Pair outcome: pair_formed_within_7d counts only pairs where audit events prove both people joined the same team within 7 days after the impression. It proves formation, not causation; present match scores as a transparent heuristic until post-event outcome data exists.',
    };
  });
  // ---- Retention sweep (review-driven): the manual retention policy in
  // docs/operations.md only bounds free-DB growth if it is actually performed
  // and tracked. This endpoint performs it: dry-run by default, each real
  // sweep is audited with per-table counts. Expired auth artifacts, stale
  // rate-limit/idempotency windows, dispatched domain events past the SSE
  // replay window, old suggestion impressions and metric rollups are pruned;
  // audit_log and live user/team data are NEVER touched.
  const sweepSchema = z.object({ dry_run: z.boolean().default(true) }).default({});

  app.post('/api/organizer/retention/sweep', pre, async (req: any) => {
    await rateLimit(`org:${req.userId}`, 10, 60);
    const { dry_run } = parse(sweepSchema, req.body ?? {}) ?? { dry_run: true };
    const targets: { name: string; where: string; table: string }[] = [
      { name: 'rate_limits', table: 'rate_limits', where: "window_start < now() - interval '2 hours'" },
      { name: 'idempotency_keys', table: 'idempotency_keys', where: "updated_at < now() - interval '24 hours'" },
      { name: 'auth_refresh_tokens', table: 'auth_refresh_tokens', where: "expires_at < now() - interval '7 days'" },
      { name: 'auth_action_tokens', table: 'auth_action_tokens', where: "expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day'" },
      { name: 'domain_events', table: 'domain_events', where: "dispatched_seq IS NOT NULL AND created_at < now() - interval '7 days'" },
      { name: 'suggestion_impressions', table: 'suggestion_impressions', where: "created_at < now() - interval '30 days'" },
      { name: 'metrics_rollups', table: 'metrics_rollups', where: "window_start < now() - interval '14 days'" },
    ];
    const counts: Record<string, number> = {};
    let swept = false;
    if (dry_run) {
      for (const t of targets) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${t.where}`);
        counts[t.name] = rows[0].n;
      }
    } else {
      await withTx(async (c) => {
        for (const t of targets) {
          const r = await c.query(`DELETE FROM ${t.table} WHERE ${t.where}`);
          counts[t.name] = r.rowCount ?? 0;
        }
        const h = await currentHackathon();
        await c.query(
          `INSERT INTO audit_log (hackathon_id, actor_id, action, metadata) VALUES ($1, $2, 'retention_sweep', $3)`,
          [h.id, req.userId, JSON.stringify({ pruned: counts })],
        );
      });
      swept = true;
    }
    // Last-sweep tracking: when was retention most recently performed?
    const { rows: last } = await pool.query(
      `SELECT max(created_at) AS at FROM audit_log WHERE action = 'retention_sweep'`,
    );
    return { dry_run, swept, counts, last_swept_at: last[0].at ?? null };
  });
}
