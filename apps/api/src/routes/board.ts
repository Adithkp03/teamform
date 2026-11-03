import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../util.js';
import { pool } from '../db.js';
import { authenticate, requireOrganizer } from '../auth.js';
import { readBoard } from '../boardcache.js';

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
  // Server-side search + filters: q matches team names / people names,
  // skill and timezone filter both sides. Filters are part of the cache key
  // and stay in effect while the client pages (it resends them).
  const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    teams_cursor: z.string().max(200).optional(),
    people_cursor: z.string().max(200).optional(),
    q: z.string().trim().max(80).optional(),
    skill: z.string().trim().min(1).max(40).optional(),
    timezone: z.string().trim().max(60).optional(),
    min_open_seats: z.coerce.number().int().min(1).max(20).optional(),
  });
  app.get('/api/board', { preHandler: authenticate }, async (req: any) => {
    const query = parse(querySchema, req.query ?? {});
    const limit = query.limit;
    const tc = parseCursor(query.teams_cursor);
    const pc = parseCursor(query.people_cursor);
    const q = query.q ? `%${query.q.replace(/[%_\\]/g, (m) => '\\' + m)}%` : null;
    const cacheKey = [limit, query.teams_cursor ?? '', query.people_cursor ?? '', q ?? '', query.skill ?? '', query.timezone ?? '', query.min_open_seats ?? ''].join('|');
    return readBoard(cacheKey, async () => {
      const teams = pool.query(
        // The timezone filter applies to TEAMS as well as people (matched on
        // the leader's timezone, the same signal the card's match reason
        // shows), so the board copy "filters apply across the whole board" is
        // true. Filtering happens inside the page CTE so pagination counts
        // only matching teams.
        `WITH page AS (
           SELECT t.id, t.name, t.wanted_skills, t.created_at, t.leader_id, t.member_count,
                  h.team_size_min, h.team_size_max,
                  lp.display_name AS leader_name, lp.timezone AS leader_timezone,
                  jr.id AS my_pending_request_id
           FROM teams t
           JOIN hackathons h ON h.id = t.hackathon_id
           JOIN profiles lp ON lp.id = t.leader_id
           LEFT JOIN join_requests jr ON jr.team_id = t.id AND jr.user_id = $8 AND jr.status = 'pending'
           WHERE t.looking_for_members
             AND t.member_count < h.team_size_max
             AND ($4::text IS NULL OR t.name ILIKE $4)
             AND ($5::text IS NULL OR $5 = ANY(t.wanted_skills))
             AND ($6::int IS NULL OR (h.team_size_max - t.member_count) >= $6)
             AND ($7::text IS NULL OR lp.timezone = $7)
             AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
           ORDER BY t.created_at DESC, t.id DESC
           LIMIT $1
         )
         SELECT page.*, (page.member_count >= page.team_size_min) AS is_complete
         FROM page
         ORDER BY page.created_at DESC, page.id DESC`,
        [limit, tc?.ts ?? null, tc?.id ?? null, q, query.skill ?? null, query.min_open_seats ?? null, query.timezone ?? null, req.userId],
      );
      const people = pool.query(
        `SELECT p.id, p.display_name, p.skills, p.timezone, p.last_active_at
         FROM profiles p
         WHERE p.looking_for_team
           AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = p.id)
           AND ($4::text IS NULL OR p.display_name ILIKE $4)
           AND ($5::text IS NULL OR $5 = ANY(p.skills))
           AND ($6::text IS NULL OR p.timezone = $6)
           AND ($2::timestamptz IS NULL OR (p.last_active_at, p.id) < ($2::timestamptz, $3::uuid))
         ORDER BY p.last_active_at DESC, p.id DESC
         LIMIT $1`,
        [limit, pc?.ts ?? null, pc?.id ?? null, q, query.skill ?? null, query.timezone ?? null],
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
      return body;
    });
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    // Exact deployed commit (Vercel injects VERCEL_GIT_COMMIT_SHA), so a live
    // claim can always be tied to the code actually serving it.
    return { ok: true, commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? null };
  });

  // In-process operational telemetry. Organizer-only: pool occupancy and
  // per-route latency are operational details, not public information.
  app.get('/api/metrics', { preHandler: requireOrganizer }, async () => {
    const { snapshot, flushToDb, durable24h } = await import('../metrics.js');
    await flushToDb();
    return { ...snapshot(), durable_24h: await durable24h(), rollup_retention: '14 days, pruned on every flush' };
  });
}
