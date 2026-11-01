import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { authenticate } from '../auth.js';

export default async function boardRoutes(app: FastifyInstance) {
  // The "looking for teammates" board. Single indexed query per side; this is the
  // endpoint the load test targets (p95 < 200 ms at 100 concurrent users).
  app.get('/api/board', { preHandler: authenticate }, async (req: any) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const teams = await pool.query(
      `SELECT t.id, t.name, t.wanted_skills, t.created_at,
              h.team_size_min, h.team_size_max,
              count(tm.user_id)::int AS member_count,
              p.display_name AS leader_name
       FROM teams t
       JOIN hackathons h ON h.id = t.hackathon_id
       JOIN team_members tm ON tm.team_id = t.id
       JOIN profiles p ON p.id = t.leader_id
       WHERE t.looking_for_members
       GROUP BY t.id, h.team_size_min, h.team_size_max, p.display_name
       HAVING count(tm.user_id) < h.team_size_max
       ORDER BY t.created_at DESC
       LIMIT $1`,
      [limit],
    );
    const people = await pool.query(
      `SELECT p.id, p.display_name, p.skills, p.timezone
       FROM profiles p
       WHERE p.looking_for_team
         AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = p.id)
       ORDER BY p.last_active_at DESC
       LIMIT $1`,
      [limit],
    );
    return { teams: teams.rows, people: people.rows, generated_at: new Date().toISOString() };
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
