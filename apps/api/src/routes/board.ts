import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { authenticate } from '../auth.js';
import { cachedBoard, storeBoard, boardGeneration } from '../boardcache.js';

// Opaque keyset cursors: base64url("timestamp|id"). Keyset pagination keeps
// page 2+ correct while rows are inserted at the head (no OFFSET drift).
function parseCursor(raw: unknown): { ts: string; id: string } | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const [ts, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (!ts || !id || Number.isNaN(Date.parse(ts))) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { ts, id };
  } catch { return null; }
}
const encCursor = (ts: unknown, id: string) =>
  Buffer.from(`${new Date(ts as string).toISOString()}|${id}`).toString('base64url');

export default async function boardRoutes(app: FastifyInstance) {
  // The "looking for teammates" board. Single indexed query per side; this is the
  // endpoint the load test targets (p95 < 200 ms at 100 concurrent users).
  app.get('/api/board', { preHandler: authenticate }, async (req: any) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const tc = parseCursor(req.query?.teams_cursor);
    const pc = parseCursor(req.query?.people_cursor);
    const cacheKey = `${limit}|${req.query?.teams_cursor ?? ''}|${req.query?.people_cursor ?? ''}`;
    const hit = cachedBoard(cacheKey);
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
           AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT $1
       )
       SELECT page.id, page.name, page.wanted_skills, page.created_at,
              page.team_size_min, page.team_size_max, page.member_count,
              (page.member_count >= page.team_size_min) AS is_complete,
              p.display_name AS leader_name
       FROM page
       JOIN profiles p ON p.id = page.leader_id
       ORDER BY page.created_at DESC, page.id DESC`,
      [limit, tc?.ts ?? null, tc?.id ?? null],
    );
    const people = pool.query(
      `SELECT p.id, p.display_name, p.skills, p.timezone, p.last_active_at
       FROM profiles p
       WHERE p.looking_for_team
         AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = p.id)
         AND ($2::timestamptz IS NULL OR (p.last_active_at, p.id) < ($2::timestamptz, $3::uuid))
       ORDER BY p.last_active_at DESC, p.id DESC
       LIMIT $1`,
      [limit, pc?.ts ?? null, pc?.id ?? null],
    );
    const [teamsR, peopleR] = await Promise.all([teams, people]);
    const lastT = teamsR.rows[teamsR.rows.length - 1];
    const lastP = peopleR.rows[peopleR.rows.length - 1];
    const body = {
      teams: teamsR.rows,
      // last_active_at is selected for cursor encoding only - never exposed.
      people: peopleR.rows.map(({ last_active_at, ...rest }: any) => rest),
      next_teams_cursor: teamsR.rows.length === limit && lastT ? encCursor(lastT.created_at, lastT.id) : null,
      next_people_cursor: peopleR.rows.length === limit && lastP ? encCursor(lastP.last_active_at, lastP.id) : null,
      generated_at: new Date().toISOString(),
    };
    storeBoard(cacheKey, body, readGen);
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
