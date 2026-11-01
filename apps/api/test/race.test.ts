import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';
import { pool } from '../src/db.js';

beforeAll(migrate);
beforeEach(() => resetDb());

async function joinByCode(token: string, code: string, key = idemKey()) {
  const res = await app.inject({
    method: 'POST', url: '/api/teams/join-by-code',
    headers: { ...auth(token), 'idempotency-key': key },
    payload: { code },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('race-proofing', () => {
  test('50 concurrent joins for the LAST seat: exactly one wins', async () => {
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token)).json().team; // max 4; fill to 3
    for (let i = 0; i < 2; i++) {
      const u = await makeUser(`Seed${i}`);
      await joinByCode(u.token, team.invite_code);
    }
    const racers = await Promise.all(Array.from({ length: 50 }, (_, i) => makeUser(`Racer${i}`)));
    const results = await Promise.all(racers.map((r) => joinByCode(r.token, team.invite_code)));

    const wins = results.filter((r) => r.status === 201);
    const fulls = results.filter((r) => r.status === 409 && r.body.error.code === 'team_full');
    const others = results.filter((r) => r.status !== 201 && !(r.status === 409 && r.body.error.code === 'team_full'));

    expect(wins.length, `expected exactly 1 winner, got ${wins.length}: ${JSON.stringify(others)}`).toBe(1);
    expect(fulls.length).toBe(49);
    expect(others.length).toBe(0);

    const { rows } = await pool.query('SELECT count(*)::int n FROM team_members WHERE team_id = $1', [team.id]);
    expect(rows[0].n).toBe(4); // exactly at capacity, never over

    const audit = await pool.query(`SELECT count(*)::int n FROM audit_log WHERE team_id = $1 AND action = 'member_joined'`, [team.id]);
    expect(audit.rows[0].n).toBe(3); // 2 seed joins + 1 race winner
  });

  test('30 concurrent joins for 3 seats: exactly three win, count never exceeds max', async () => {
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token)).json().team;
    const racers = await Promise.all(Array.from({ length: 30 }, (_, i) => makeUser(`R${i}`)));
    const results = await Promise.all(racers.map((r) => joinByCode(r.token, team.invite_code)));
    expect(results.filter((r) => r.status === 201).length).toBe(3);
    const { rows } = await pool.query('SELECT count(*)::int n FROM team_members WHERE team_id = $1', [team.id]);
    expect(rows[0].n).toBe(4);
  });

  test('concurrent accepts for the last seat: exactly one request is accepted', async () => {
    await resetDb({ min: 2, max: 2 });
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token)).json().team; // 1 seat left
    const askers = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(`A${i}`)));
    const requests = await Promise.all(askers.map((a) =>
      app.inject({ method: 'POST', url: `/api/teams/${team.id}/requests`, headers: { ...auth(a.token), 'idempotency-key': idemKey() }, payload: {} })
        .then((r) => r.json().request.id),
    ));
    const results = await Promise.all(requests.map((id) =>
      app.inject({ method: 'POST', url: `/api/requests/${id}/accept`, headers: auth(leader.token) }).then((r) => r.statusCode),
    ));
    expect(results.filter((s) => s === 200).length).toBe(1);
    expect(results.filter((s) => s === 409).length).toBe(9);
    const { rows } = await pool.query('SELECT count(*)::int n FROM team_members WHERE team_id = $1', [team.id]);
    expect(rows[0].n).toBe(2);
  });

  test('same person racing to join two teams lands in exactly one', async () => {
    const l1 = await makeUser('L1');
    const l2 = await makeUser('L2');
    const t1 = (await createTeam(l1.token, 'T1')).json().team;
    const t2 = (await createTeam(l2.token, 'T2')).json().team;
    const u = await makeUser('Greedy');
    const results = await Promise.all([joinByCode(u.token, t1.invite_code), joinByCode(u.token, t2.invite_code)]);
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    const { rows } = await pool.query('SELECT count(*)::int n FROM team_members WHERE user_id = $1', [u.id]);
    expect(rows[0].n).toBe(1);
  });

  test('concurrent double-click with the SAME idempotency key: one membership, consistent response', async () => {
    const leader = await makeUser('Leader');
    const joiner = await makeUser('Joiner');
    const team = (await createTeam(leader.token)).json().team;
    const key = idemKey();
    const [a, b] = await Promise.all([joinByCode(joiner.token, team.invite_code, key), joinByCode(joiner.token, team.invite_code, key)]);
    const { rows } = await pool.query('SELECT count(*)::int n FROM team_members WHERE user_id = $1', [joiner.id]);
    expect(rows[0].n).toBe(1);
    // whichever finished first owns the key; a later retry replays the stored response
    const retry = await joinByCode(joiner.token, team.invite_code, key);
    expect(retry.status).toBe(201);
    expect(retry.body.team_id).toBe(team.id);
    const { rows: rows2 } = await pool.query('SELECT count(*)::int n FROM team_members WHERE user_id = $1', [joiner.id]);
    expect(rows2[0].n).toBe(1);
    expect([a.status, b.status].sort()).toEqual([201, 409]); // one ran, one saw request_in_flight
  });

  test('double-click create team with the same key never makes two teams', async () => {
    const u = await makeUser();
    const key = idemKey();
    const payload = { name: 'Clicked Twice' };
    const mk = () => app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload });
    await Promise.all([mk(), mk()]);
    const replay = await mk();
    expect(replay.statusCode).toBe(201);
    const { rows } = await pool.query('SELECT count(*)::int n FROM teams WHERE name = $1', ['Clicked Twice']);
    expect(rows[0].n).toBe(1);
  });

  test('a race loser retrying with the same key gets the same stored 409', async () => {
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token)).json().team;
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(`F${i}`);
      await joinByCode(u.token, team.invite_code);
    }
    const loser = await makeUser('Loser');
    const key = idemKey();
    const first = await joinByCode(loser.token, team.invite_code, key);
    expect(first.status).toBe(409);
    const second = await joinByCode(loser.token, team.invite_code, key);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('team_full');
  });

  test('leader leaving while a join is in flight stays consistent', async () => {
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token)).json().team;
    const joiners = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(`J${i}`)));
    const [leave, ...joins] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(leader.token) }).then((r) => r.statusCode),
      ...joiners.map((j) => joinByCode(j.token, team.invite_code).then((r) => r.status)),
    ]);
    expect(leave).toBe(200);
    const { rows: teamRows } = await pool.query('SELECT * FROM teams WHERE id = $1', [team.id]);
    const { rows: memberRows } = await pool.query('SELECT count(*)::int n FROM team_members WHERE team_id = $1', [team.id]);
    if (teamRows.length === 0) {
      // team deleted (leader left first and nobody got in): no members, joins failed
      expect(memberRows[0].n).toBe(0);
      expect(joins.every((s) => s === 404 || s === 409)).toBe(true);
    } else {
      // some joins landed: count respects max, leadership (if leader was among members) is consistent
      expect(memberRows[0].n).toBeLessThanOrEqual(4);
    }
  });
});
