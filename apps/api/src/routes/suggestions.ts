import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { authenticate } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import { parse } from '../util.js';

/**
 * Teammate suggestions, ranked by an explained score:
 *   score = 2 * complementary_skills   (skills they have that you don't)
 *         + 1 * shared_skills          (common ground helps collaboration)
 *         + timezone_fit               (same clock time = 2, clock-time within 2h = 1, else 0;
 *           distance is circular on the 24h clock, so UTC-12 vs UTC+14 is 2h apart,
 *           not 26h. Offsets are derived LIVE from the IANA zone name at serve
 *           time (Postgres tz database), so a DST change never skews scoring;
 *           free-form zone names fall back to the saved offset.)
 * Every candidate in the response carries the score components so the ranking
 * is explainable, not a black box. Deterministic tie-break: most recently active.
 */
export default async function suggestionRoutes(app: FastifyInstance) {
  app.get('/api/suggestions', { preHandler: authenticate }, async (req: any) => {
    await rateLimit(`suggest:${req.userId}`, 30, 60);
    const { rows } = await pool.query(
      `WITH me AS (SELECT skills, timezone, utc_offset_minutes FROM profiles WHERE id = $1),
            live_offset AS (
              SELECT CASE WHEN p.timezone IN (SELECT name FROM pg_timezone_names)
                          THEN round(EXTRACT(EPOCH FROM (now() AT TIME ZONE p.timezone - now() AT TIME ZONE 'UTC')) / 60)::int
                          ELSE p.utc_offset_minutes END AS off, p.id AS pid
              FROM profiles p
            ),
            me_off AS (
              SELECT CASE WHEN m.timezone IN (SELECT name FROM pg_timezone_names)
                          THEN round(EXTRACT(EPOCH FROM (now() AT TIME ZONE m.timezone - now() AT TIME ZONE 'UTC')) / 60)::int
                          ELSE m.utc_offset_minutes END AS off
              FROM me m
            ),
            scored AS (
         SELECT p.id, p.display_name, p.skills, p.timezone, p.last_active_at,
           (SELECT count(*)::int FROM (SELECT unnest(p.skills) EXCEPT SELECT unnest(me.skills)) d) AS complementary_skills,
           (SELECT count(*)::int FROM (SELECT unnest(p.skills) INTERSECT SELECT unnest(me.skills)) s) AS shared_skills,
           (SELECT coalesce(array_agg(x.skill), '{}') FROM (SELECT unnest(p.skills) AS skill EXCEPT SELECT unnest(me.skills)) x) AS complementary_skill_names,
           (SELECT coalesce(array_agg(y.skill), '{}') FROM (SELECT unnest(p.skills) AS skill INTERSECT SELECT unnest(me.skills)) y) AS shared_skill_names,
           (CASE WHEN least((abs(lo.off - mo.off)) % 1440,
                            1440 - ((abs(lo.off - mo.off)) % 1440)) = 0 THEN 2
                 WHEN least((abs(lo.off - mo.off)) % 1440,
                            1440 - ((abs(lo.off - mo.off)) % 1440)) <= 120 THEN 1
                 ELSE 0 END) AS timezone_fit
         FROM profiles p, me, live_offset lo, me_off mo
         WHERE lo.pid = p.id AND p.looking_for_team AND p.id <> $1
           AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = p.id)
       )
       SELECT *, (2 * complementary_skills + shared_skills + timezone_fit) AS score
       FROM scored
       ORDER BY score DESC, last_active_at DESC
       LIMIT 20`,
      [req.userId],
    );
    const shortList = (names: string[]) =>
      names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
    const suggestions = rows.map((r: any) => {
      const parts: string[] = [];
      const comp: string[] = r.complementary_skill_names ?? [];
      const shared: string[] = r.shared_skill_names ?? [];
      if (comp.length) parts.push(`adds ${shortList(comp)} that you don't have`);
      if (shared.length) parts.push(`shares ${shortList(shared)} with you`);
      if (r.timezone_fit === 2) parts.push('same local hours as you');
      else if (r.timezone_fit === 1) parts.push('local time within 2 hours of yours');
      else parts.push('in a different timezone');
      return { ...r, reason: parts.join('; ') };
    });
    // Instrumentation for matching-quality validation (review-driven):
    // record what was served so organizers can measure real outcomes
    // (candidate joins a team, direct usefulness votes) instead of trusting
    // the heuristic blind. Fire-and-forget: analytics must never break the
    // endpoint, and never slows the response beyond one batch insert.
    if (rows.length) {
      const n = rows.length;
      const values = rows.map((_: any, i: number) => `($1, $${i + 2}, $${i + 2 + n})`).join(',');
      pool.query(
        `INSERT INTO suggestion_impressions (user_id, candidate_id, score) VALUES ${values}`,
        [req.userId, ...rows.map((r: any) => r.id), ...rows.map((r: any) => r.score)],
      ).catch(() => {});
      // Bounded storage on the free DB: impressions are a rolling 30-day
      // window, pruned probabilistically (~2% of serves) so the table cannot
      // grow without limit. Feedback votes are keyed per (user, candidate)
      // and bounded by participant count squared in the worst case.
      if (Math.random() < 0.02) {
        pool.query(`DELETE FROM suggestion_impressions WHERE created_at < now() - interval '30 days'`).catch(() => {});
      }
    }
    return {
      scoring: 'score = 2*complementary_skills + 1*shared_skills + timezone_fit (same clock time=2, within 2h incl. UTC wraparound=1, else 0)',
      scoring_status: 'transparent heuristic - being validated against real join outcomes and feedback',
      suggestions,
    };
  });

  // Direct usefulness vote on a served suggestion. One vote per
  // (user, candidate); voting again updates it. Upsert makes replays safe.
  app.post('/api/suggestions/feedback', { preHandler: authenticate }, async (req: any) => {
    await rateLimit(`suggest_fb:${req.userId}`, 30, 60);
    const body = parse(z.object({ candidate_id: z.string().uuid(), useful: z.boolean() }), req.body);
    await pool.query(
      `INSERT INTO suggestion_feedback (user_id, candidate_id, useful) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, candidate_id) DO UPDATE SET useful = EXCLUDED.useful, updated_at = now()`,
      [req.userId, body.candidate_id, body.useful],
    );
    return { ok: true };
  });
}
