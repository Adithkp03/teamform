import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { authenticate } from '../auth.js';
import { rateLimit } from '../ratelimit.js';

/**
 * Teammate suggestions, ranked by an explained score:
 *   score = 2 * complementary_skills   (skills they have that you don't)
 *         + 1 * shared_skills          (common ground helps collaboration)
 *         + timezone_fit               (same offset = 2, within 2h = 1, else 0)
 * Every candidate in the response carries the score components so the ranking
 * is explainable, not a black box. Deterministic tie-break: most recently active.
 */
export default async function suggestionRoutes(app: FastifyInstance) {
  app.get('/api/suggestions', { preHandler: authenticate }, async (req: any) => {
    await rateLimit(`suggest:${req.userId}`, 30, 60);
    const { rows } = await pool.query(
      `WITH me AS (SELECT skills, utc_offset_minutes FROM profiles WHERE id = $1),
            scored AS (
         SELECT p.id, p.display_name, p.skills, p.timezone, p.last_active_at,
           (SELECT count(*)::int FROM (SELECT unnest(p.skills) EXCEPT SELECT unnest(me.skills)) d) AS complementary_skills,
           (SELECT count(*)::int FROM (SELECT unnest(p.skills) INTERSECT SELECT unnest(me.skills)) s) AS shared_skills,
           (CASE WHEN p.utc_offset_minutes = me.utc_offset_minutes THEN 2
                 WHEN abs(p.utc_offset_minutes - me.utc_offset_minutes) <= 120 THEN 1
                 ELSE 0 END) AS timezone_fit
         FROM profiles p, me
         WHERE p.looking_for_team AND p.id <> $1
           AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = p.id)
       )
       SELECT *, (2 * complementary_skills + shared_skills + timezone_fit) AS score
       FROM scored
       ORDER BY score DESC, last_active_at DESC
       LIMIT 20`,
      [req.userId],
    );
    return {
      scoring: 'score = 2*complementary_skills + 1*shared_skills + timezone_fit (same tz=2, within 2h=1, else 0)',
      suggestions: rows,
    };
  });
}
