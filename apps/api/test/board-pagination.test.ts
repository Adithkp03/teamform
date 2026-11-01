import { beforeAll, beforeEach, expect, test } from 'vitest';
import { app, migrate, resetDb, auth, makeUser, createTeam } from './helpers.js';
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
