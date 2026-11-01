import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { authenticate } from '../auth.js';
import { cachedBoard, storeBoard, boardGeneration } from '../boardcache.js';

export default async function boardRoutes(app: FastifyInstance) {
  // The "looking for teammates" board. Single indexed query per side; this is the
  // endpoint the load test targets (p95 < 200 ms at 100 concurrent users).
  app.get('/api/board', { preHandler: authenticate }, async (req: any) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const hit = cachedBoard(limit);
    if (hit) return hit;
    const readGen = boardGeneration();
    const teams = pool.query(
      `WITH page AS (
         SELECT t.id, t.name, t.wanted_skills, t.created_at, t.leader_id, t.member_count,
                h.team_size_min, h.team_size_max
         FROM teams t
         JOIN hackathons h ON h.id = t.hackathon_id
         WHERE t.looking_for_members
           AND t.member_count < h.team_size_max
         ORDER BY t.created_at DESC
         LIMIT $1
       )
       SELECT page.id, page.name, page.wanted_skills, page.created_at,
              page.team_size_min, page.team_size_max, page.member_count,
              (page.member_count >= page.team_size_min) AS is_complete,
              p.display_name AS leader_name
       FROM page
       JOIN profiles p ON p.id = page.leader_id
       ORDER BY page.created_at DESC`,
      [limit],
    );
    const people = pool.query(
      `SELECT p.id, p.display_name, p.skills, p.timezone
       FROM profiles p
       WHERE p.looking_for_team
         AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = p.id)
       ORDER BY p.last_active_at DESC
       LIMIT $1`,
      [limit],
    );
    const [teamsR, peopleR] = await Promise.all([teams, people]);
    const body = { teams: teamsR.rows, people: peopleR.rows, generated_at: new Date().toISOString() };
    storeBoard(limit, body, readGen);
    return body;
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.get('/api/metrics', async () => {
    const { snapshot } = await import('../metrics.js');
    return snapshot();
  });
}
