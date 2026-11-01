import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';
import { pool } from '../src/db.js';

// teams.member_count is a trigger-maintained denormalization used by the
// board for display/filtering. These tests pin its reconciliation with the
// live team_members rows across every mutation path, including rollbacks
// and concurrent joins. Seat enforcement never reads the counter.

beforeAll(migrate);
beforeEach(() => resetDb());

async function reconcile(teamId?: string) {
  const { rows } = teamId
    ? await pool.query(
        `SELECT t.id, t.member_count, (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS live
         FROM teams t WHERE t.id = $1`, [teamId])
    : await pool.query(
        `SELECT t.id, t.member_count, (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS live
         FROM teams t`);
  for (const r of rows) expect(r.member_count, `team ${r.id}`).toBe(r.live);
  return rows;
}

const joinByCode = (token: string, code: string) =>
  app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(token), 'idempotency-key': idemKey() }, payload: { code } });

describe('member_count reconciliation', () => {
  test('create team starts at 1; join increments; leave decrements', async () => {
    const leader = await makeUser('L');
    const joiner = await makeUser('J');
    const created = await createTeam(leader.token, 'CountTeam');
    const team = created.json().team;
    await reconcile(team.id);
    expect((await reconcile(team.id))[0].member_count).toBe(1);

    expect((await joinByCode(joiner.token, team.invite_code)).statusCode).toBe(201);
    expect((await reconcile(team.id))[0].member_count).toBe(2);

    const leave = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(joiner.token) });
    expect(leave.statusCode).toBe(200);
    expect((await reconcile(team.id))[0].member_count).toBe(1);
  });

  test('leader remove decrements', async () => {
    const leader = await makeUser('L');
    const member = await makeUser('M');
    const team = (await createTeam(leader.token, 'KickTeam')).json().team;
    await joinByCode(member.token, team.invite_code);
    const res = await app.inject({ method: 'DELETE', url: `/api/teams/${team.id}/members/${member.id}`, headers: auth(leader.token) });
    expect(res.statusCode).toBe(200);
    expect((await reconcile(team.id))[0].member_count).toBe(1);
  });

  test('last member leaving deletes the team (no orphan counter row)', async () => {
    const leader = await makeUser('L');
    const team = (await createTeam(leader.token, 'LastOut')).json().team;
    const res = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(leader.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().team_deleted).toBe(true);
    const { rows } = await pool.query('SELECT 1 FROM teams WHERE id = $1', [team.id]);
    expect(rows.length).toBe(0);
    await reconcile(); // whole table consistent
  });

  test('failed joins roll back without touching the counter', async () => {
    const leader = await makeUser('L');
    const team = (await createTeam(leader.token, 'Rollback')).json().team;
    const before = (await reconcile(team.id))[0].member_count;

    // wrong code
    const u1 = await makeUser('U1');
    expect((await joinByCode(u1.token, 'WRONGCODE1')).statusCode).toBe(404);
    // duplicate join (already a member -> second team join rejected)
    expect((await joinByCode(leader.token, team.invite_code)).statusCode).toBeGreaterThanOrEqual(400);

    expect((await reconcile(team.id))[0].member_count).toBe(before);
  });

  test('concurrent joins: counter matches live rows exactly', async () => {
    const leader = await makeUser('L');
    const team = (await createTeam(leader.token, 'Storm')).json().team; // max 4 by default
    const joiners = await Promise.all(Array.from({ length: 12 }, (_, i) => makeUser(`S${i}`)));
    const results = await Promise.all(joiners.map((j) => joinByCode(j.token, team.invite_code)));
    const joined = results.filter((r) => r.statusCode === 201).length;
    const row = (await reconcile(team.id))[0];
    expect(row.member_count).toBe(1 + joined); // leader + winners, no drift under contention
    expect(row.member_count).toBeLessThanOrEqual(4);
  });
});
