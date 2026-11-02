import { beforeAll, beforeEach, expect, test } from 'vitest';
import { app, migrate, resetDb, auth, idemKey, createTeam, makeUser } from './helpers.js';
import { pool } from '../src/db.js';

beforeAll(migrate);
beforeEach(() => resetDb());

test('board search filters teams and people server-side', async () => {
  const leader = await makeUser('Alpha Leader', ['node']);
  await createTeam(leader.token, 'Rocket Builders', { wanted_skills: ['node'] });
  const other = await makeUser('Beta Leader', ['python']);
  await createTeam(other.token, 'Data Divers', { wanted_skills: ['python'] });
  await makeUser('Solo Node', ['node'], 330);
  await makeUser('Solo Python', ['python'], 330);

  const q = await app.inject({ method: 'GET', url: '/api/board?q=rocket', headers: auth(leader.token) });
  expect(q.statusCode).toBe(200);
  expect(q.json().teams.map((t: any) => t.name)).toEqual(['Rocket Builders']);

  const bySkill = await app.inject({ method: 'GET', url: '/api/board?skill=python', headers: auth(leader.token) });
  expect(bySkill.json().teams.map((t: any) => t.name)).toEqual(['Data Divers']);
  expect(bySkill.json().people.map((p: any) => p.display_name)).toEqual(['Solo Python']);

  const bad = await app.inject({ method: 'GET', url: '/api/board?limit=abc', headers: auth(leader.token) });
  expect(bad.statusCode).toBe(400);
});

test('join-by-code cancels the joiner\u2019s other pending requests and audits them', async () => {
  const leader = await makeUser('L1');
  const t1 = await createTeam(leader.token, 'Code Team');
  const code = t1.json().team.invite_code;
  const leader2 = await makeUser('L2');
  const t2 = await createTeam(leader2.token, 'Req Team');

  const joiner = await makeUser('J');
  const req = await app.inject({
    method: 'POST', url: `/api/teams/${t2.json().team.id}/requests`,
    headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: {},
  });
  expect(req.statusCode).toBe(201);

  const join = await app.inject({
    method: 'POST', url: '/api/teams/join-by-code',
    headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: { code },
  });
  expect(join.statusCode).toBe(201);

  const { rows } = await pool.query(`SELECT status FROM join_requests WHERE user_id = $1`, [joiner.id]);
  expect(rows[0].status).toBe('cancelled');
  const { rows: auditRows } = await pool.query(
    `SELECT 1 FROM audit_log WHERE action = 'join_request_auto_cancelled' AND actor_id = $1`, [joiner.id]);
  expect(auditRows.length).toBe(1);
});

test('accept when the requester already joined elsewhere: 409 body AND the stale request stays cancelled', async () => {
  const leader = await makeUser('LA');
  const t1 = await createTeam(leader.token, 'First');
  const leader2 = await makeUser('LB');
  const t2 = await createTeam(leader2.token, 'Second');
  const joiner = await makeUser('JJ');

  const req = await app.inject({
    method: 'POST', url: `/api/teams/${t2.json().team.id}/requests`,
    headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: {},
  });
  const reqId = req.json().request.id;
  // simulate the race: the requester acquired a seat elsewhere between their
  // request and the leader's accept (direct insert, as a concurrent tx would)
  await pool.query(
    `INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
    [t1.json().team.id, t1.json().team.hackathon_id, joiner.id],
  );

  const accept = await app.inject({ method: 'POST', url: `/api/requests/${reqId}/accept`, headers: { ...auth(leader2.token), 'idempotency-key': idemKey() } });
  expect(accept.statusCode).toBe(409);
  expect(accept.json().error.code).toBe('requester_already_in_team');
  // the cancellation was committed, not rolled back with the conflict
  const { rows } = await pool.query(`SELECT status FROM join_requests WHERE id = $1`, [reqId]);
  expect(rows[0].status).toBe('cancelled');
});

test('non-uuid path params are rejected with 400 before any lookup', async () => {
  const u = await makeUser('V');
  const res = await app.inject({ method: 'GET', url: '/api/teams/not-a-uuid', headers: auth(u.token) });
  expect(res.statusCode).toBe(400);
  const res2 = await app.inject({ method: 'POST', url: '/api/requests/nope/accept', headers: { ...auth(u.token), 'idempotency-key': idemKey() } });
  expect(res2.statusCode).toBe(400);
});

test('min_open_seats filters teams by remaining capacity', async () => {
  const a = await makeUser('Cap A');
  const b = await makeUser('Cap B');
  // 1 of 4 seats taken -> 3 open
  const t1 = await createTeam(a.token, 'Roomy Team');
  expect(t1.statusCode).toBe(201);
  const t2 = await createTeam(b.token, 'Tight Team');
  expect(t2.statusCode).toBe(201);
  const code2 = t2.json().team.invite_code;
  for (const u of [await makeUser('Cap C'), await makeUser('Cap D')]) {
    const j = await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(u.token), 'idempotency-key': idemKey() }, payload: { code: code2 } });
    expect(j.statusCode).toBe(201);
  }
  // Tight Team is now 3 of 4 -> 1 open
  const viewer = await makeUser('Cap V');
  const all = await app.inject({ method: 'GET', url: '/api/board?limit=24', headers: auth(viewer.token) });
  const names = all.json().teams.map((t: any) => t.name);
  expect(names).toContain('Roomy Team');
  expect(names).toContain('Tight Team');
  const roomyOnly = await app.inject({ method: 'GET', url: '/api/board?limit=24&min_open_seats=2', headers: auth(viewer.token) });
  const names2 = roomyOnly.json().teams.map((t: any) => t.name);
  expect(names2).toContain('Roomy Team');
  expect(names2).not.toContain('Tight Team');
  expect((await app.inject({ method: 'GET', url: '/api/board?min_open_seats=0', headers: auth(viewer.token) })).statusCode).toBe(400);
});
