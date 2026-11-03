import { beforeAll, beforeEach, expect, test } from 'vitest';
import { app, migrate, resetDb, auth, makeUser, createTeam } from './helpers.js';
import { pool } from '../src/db.js';
import { invalidateBoard } from '../src/boardcache.js';

beforeAll(() => { migrate(); });
beforeEach(async () => { await resetDb(); });

test('teams side paginates with a keyset cursor: no duplicates, no gaps, stable order', async () => {
  // Five teams from five distinct owners (a solo leader leaving deletes the team).
  const viewer = await makeUser('Viewer');
  for (let i = 1; i <= 5; i++) {
    const owner = await makeUser(`Owner ${i}`);
    const res = await createTeam(owner.token, `Team ${i}`);
    expect(res.statusCode).toBe(201);
  }
  invalidateBoard(); // makeUser writes bypass HTTP invalidation

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url: string = `/api/board?limit=2${cursor ? `&teams_cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await app.inject({ method: 'GET', url, headers: auth(viewer.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    seen.push(...body.teams.map((t: any) => t.name));
    cursor = body.next_teams_cursor;
    pages++;
  } while (cursor && pages < 10);

  expect(pages).toBe(3); // 2 + 2 + 1
  expect(seen).toEqual(['Team 5', 'Team 4', 'Team 3', 'Team 2', 'Team 1']); // newest first
  expect(new Set(seen).size).toBe(5); // no duplicates across pages
});

test('people side paginates and a bogus cursor falls back to the first page', async () => {
  const a = await makeUser('A');
  await makeUser('B');
  await makeUser('C');
  invalidateBoard(); // makeUser writes bypass HTTP invalidation
  const p1 = await app.inject({ method: 'GET', url: '/api/board?limit=2', headers: auth(a.token) });
  expect(p1.json().people.length).toBe(2);
  expect(p1.json().next_people_cursor).toBeTruthy();
  const p2 = await app.inject({ method: 'GET', url: `/api/board?limit=2&people_cursor=${encodeURIComponent(p1.json().next_people_cursor)}`, headers: auth(a.token) });
  const ids = [...p1.json().people, ...p2.json().people].map((p: any) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  const bogus = await app.inject({ method: 'GET', url: '/api/board?limit=2&people_cursor=!!!not-a-cursor', headers: auth(a.token) });
  expect(bogus.statusCode).toBe(200);
  expect(bogus.json().people.length).toBe(2); // treated as no cursor
});

test('205 identical-timestamp teams and people paginate uniquely to exact exhaustion', async () => {
  // Regression: rows bulk-inserted in one statement share one timestamp; a
  // millisecond-floored cursor mis-sorted them and page 2 came back empty.
  // Epoch-microsecond keyset cursors must paginate the full set with no
  // duplicates and exact exhaustion, on BOTH sides of the board.
  const viewer = await makeUser('Viewer');
  await pool.query(`UPDATE profiles SET looking_for_team = false WHERE id = $1`, [viewer.id]);
  const { rows: [h] } = await pool.query(`SELECT id FROM hackathons LIMIT 1`);
  const TS = '2026-01-01T00:00:00.123456Z';
  const { rows: [leader] } = await pool.query(
    `INSERT INTO profiles (id, display_name, looking_for_team, last_active_at) VALUES (gen_random_uuid(), 'CursorLeader', false, $1) RETURNING id`, [TS]);
  await pool.query(
    `INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at, member_count, created_at)
     SELECT $1, 'CursorTeam ' || lpad(g::text, 3, '0'), $2, 'CT' || g, now() + interval '7 days', 1, $3
     FROM generate_series(1, 205) g`, [h.id, leader.id, TS]);
  // People side: 205 lookers sharing one last_active_at, none in a team.
  await pool.query(
    `INSERT INTO profiles (id, display_name, looking_for_team, last_active_at)
     SELECT gen_random_uuid(), 'Looker ' || g, true, $1 FROM generate_series(1, 205) g`, [TS]);
  invalidateBoard();

  const pageOut = async (side: 'teams' | 'people') => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const param = side === 'teams' ? 'teams_cursor' : 'people_cursor';
      const url: string = `/api/board?limit=24${cursor ? `&${param}=${encodeURIComponent(cursor)}` : ''}`;
      const res: any = await app.inject({ method: 'GET', url, headers: auth(viewer.token) });
      expect(res.statusCode).toBe(200);
      const body: any = res.json();
      seen.push(...body[side].map((r: any) => r.id));
      cursor = side === 'teams' ? body.next_teams_cursor : body.next_people_cursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(10); // no infinite cursor loop
    } while (cursor);
    return { seen, pages };
  };

  const teams = await pageOut('teams');
  expect(teams.pages).toBe(9); // 24 * 8 + 13
  expect(teams.seen.length).toBe(205);
  expect(new Set(teams.seen).size).toBe(205); // zero duplicates across pages

  const people = await pageOut('people');
  expect(people.pages).toBe(9);
  expect(people.seen.length).toBe(205);
  expect(new Set(people.seen).size).toBe(205);
});

test('legacy millisecond-ISO cursors are accepted (no 500) and malformed cursors mean page 1', async () => {
  const viewer = await makeUser('Viewer');
  for (let i = 1; i <= 3; i++) {
    const owner = await makeUser(`Legacy Owner ${i}`);
    const res = await createTeam(owner.token, `Legacy Team ${i}`);
    expect(res.statusCode).toBe(201);
  }
  invalidateBoard();
  const p1 = await app.inject({ method: 'GET', url: '/api/board?limit=2', headers: auth(viewer.token) });
  expect(p1.statusCode).toBe(200);
  const last = p1.json().teams[1];
  // Pre-fix clients sent base64url("Date#toISOString()|id"): millisecond precision.
  const legacy = Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url');
  const p2 = await app.inject({ method: 'GET', url: `/api/board?limit=2&teams_cursor=${encodeURIComponent(legacy)}`, headers: auth(viewer.token) });
  expect(p2.statusCode).toBe(200); // converted, never a 500
  expect(p2.json().teams.length).toBeGreaterThanOrEqual(1);
  const malformed = await app.inject({ method: 'GET', url: '/api/board?limit=2&teams_cursor=@@@', headers: auth(viewer.token) });
  expect(malformed.statusCode).toBe(200);
  expect(malformed.json().teams.length).toBe(2); // treated as no cursor
});
