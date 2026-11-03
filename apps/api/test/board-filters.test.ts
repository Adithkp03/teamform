import { describe, it, expect, beforeEach } from 'vitest';
import { app, resetDb, makeUser, createTeam, auth, idemKey } from './helpers';
import { pool } from '../src/db.js';

/** Board filter consistency: the timezone filter applies to teams (matched on
 *  the leader's timezone) as well as people, and team cards carry
 *  leader_timezone (the field the client-side match reason reads). */

describe('board: timezone filter applies to teams too', () => {
  beforeEach(() => resetDb());

  it('filters teams by leader timezone and projects leader_timezone', async () => {
    const ist = await makeUser('IST Lead');
    await pool.query(`UPDATE profiles SET timezone = 'Asia/Calcutta', utc_offset_minutes = 330 WHERE id = $1`, [ist.id]);
    const pst = await makeUser('PST Lead');
    await pool.query(`UPDATE profiles SET timezone = 'America/Los_Angeles', utc_offset_minutes = -480 WHERE id = $1`, [pst.id]);
    const t1 = (await (await createTeam(ist.token, 'Kochi Crew')).json()).team.id;
    const t2 = (await (await createTeam(pst.token, 'Cali Crew')).json()).team.id;
    const viewer = await makeUser('Viewer');

    const all = await app.inject({ method: 'GET', url: '/api/board', headers: auth(viewer.token) });
    expect(all.json().teams.map((t: any) => t.id).sort()).toEqual([t1, t2].sort());
    const card = all.json().teams.find((t: any) => t.id === t1);
    expect(card.leader_timezone).toBe('Asia/Calcutta');
    expect(card.leader_name).toBe('IST Lead');

    const filtered = await app.inject({ method: 'GET', url: '/api/board?timezone=Asia%2FCalcutta', headers: auth(viewer.token) });
    expect(filtered.json().teams.map((t: any) => t.id)).toEqual([t1]);
  });
});

describe('board: viewer pending request projected on team cards', () => {
  beforeEach(() => resetDb());

  it('my_pending_request_id is set only on the team I asked, only while pending', async () => {
    const leader = await makeUser('Lead');
    const t1 = (await (await createTeam(leader.token, 'One')).json()).team.id;
    const t2 = (await (await createTeam((await makeUser('Lead2')).token, 'Two')).json()).team.id;
    const asker = await makeUser('Asker');

    await app.inject({ method: 'POST', url: `/api/teams/${t1}/requests`, headers: { ...auth(asker.token), 'idempotency-key': idemKey() }, payload: {} });
    let board = await app.inject({ method: 'GET', url: '/api/board', headers: auth(asker.token) });
    const c1 = board.json().teams.find((t: any) => t.id === t1);
    const c2 = board.json().teams.find((t: any) => t.id === t2);
    expect(c1.my_pending_request_id).toBeTruthy();
    expect(c2.my_pending_request_id).toBeFalsy();

    // cancel -> projection clears
    await app.inject({ method: 'DELETE', url: `/api/requests/${c1.my_pending_request_id}`, headers: auth(asker.token) });
    board = await app.inject({ method: 'GET', url: '/api/board', headers: auth(asker.token) });
    expect(board.json().teams.find((t: any) => t.id === t1).my_pending_request_id).toBeFalsy();

    // another viewer never sees it
    const other = await makeUser('Other');
    await app.inject({ method: 'POST', url: `/api/teams/${t1}/requests`, headers: { ...auth(asker.token), 'idempotency-key': idemKey() }, payload: {} });
    const boardOther = await app.inject({ method: 'GET', url: '/api/board', headers: auth(other.token) });
    expect(boardOther.json().teams.find((t: any) => t.id === t1).my_pending_request_id).toBeFalsy();
  });
});
