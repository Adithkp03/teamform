import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';
import { pool } from '../src/db.js';

beforeAll(migrate);
beforeEach(() => resetDb());

describe('auth & profiles', () => {
  test('health endpoint works', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  test('unauthenticated requests are rejected', async () => {
    for (const url of ['/api/me', '/api/board', '/api/suggestions']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  test('profile upsert and read', async () => {
    const u = await makeUser('Asha', ['react'], 330);
    const put = await app.inject({
      method: 'PUT', url: '/api/me', headers: auth(u.token),
      payload: { display_name: 'Asha V', skills: ['react', 'node'], timezone: 'Asia/Kolkata', utc_offset_minutes: 330 },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/me', headers: auth(u.token) });
    expect(get.json().profile.display_name).toBe('Asha V');
    expect(get.json().profile.skills).toEqual(['react', 'node']);
  });

  test('invalid payloads get 400, not 500', async () => {
    const u = await makeUser();
    const res = await app.inject({ method: 'PUT', url: '/api/me', headers: auth(u.token), payload: { display_name: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });
});

describe('team creation rules', () => {
  test('create team makes creator the leader member', async () => {
    const u = await makeUser();
    const res = await createTeam(u.token, 'Rocketship');
    expect(res.statusCode).toBe(201);
    const team = res.json().team;
    expect(team.invite_code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    const detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(u.token) });
    expect(detail.json().members[0].role).toBe('leader');
    expect(detail.json().is_leader).toBe(true);
  });

  test('one person cannot create or join two teams in a hackathon', async () => {
    const u = await makeUser();
    await createTeam(u.token, 'First');
    const res = await createTeam(u.token, 'Second');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_in_team');
  });

  test('idempotent replay of create returns the same team, not a new one', async () => {
    const u = await makeUser();
    const key = idemKey();
    const payload = { name: 'Only Once' };
    const first = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload });
    const second = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().team.id).toBe(first.json().team.id);
    const { rows } = await pool.query('SELECT count(*)::int n FROM teams');
    expect(rows[0].n).toBe(1);
  });

  test('same idempotency key with different body is rejected', async () => {
    const u = await makeUser();
    const key = idemKey();
    await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload: { name: 'A' } });
    const res = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload: { name: 'B' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_key_reused');
  });
});

describe('invite codes', () => {
  test('join by code adds a member and shows in audit', async () => {
    const leader = await makeUser('Leader');
    const joiner = await makeUser('Joiner');
    const team = (await createTeam(leader.token)).json().team;
    const res = await app.inject({
      method: 'POST', url: '/api/teams/join-by-code',
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() },
      payload: { code: team.invite_code },
    });
    expect(res.statusCode).toBe(201);
    const audit = await app.inject({ method: 'GET', url: `/api/teams/${team.id}/audit`, headers: auth(joiner.token) });
    const actions = audit.json().audit.map((a: any) => a.action);
    expect(actions).toContain('member_joined');
    expect(actions).toContain('team_created');
  });

  test('lowercase codes still match (codes are case-insensitive)', async () => {
    const leader = await makeUser();
    const joiner = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    const res = await app.inject({
      method: 'POST', url: '/api/teams/join-by-code',
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() },
      payload: { code: team.invite_code.toLowerCase() },
    });
    expect(res.statusCode).toBe(201);
  });

  test('invalid code is 404 and brute-force attempts get rate limited', async () => {
    const u = await makeUser();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/teams/join-by-code',
        headers: { ...auth(u.token), 'idempotency-key': idemKey() },
        payload: { code: 'WRONGCODE1' },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  test('expired code is 410', async () => {
    const leader = await makeUser();
    const joiner = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    await pool.query(`UPDATE teams SET invite_expires_at = now() - interval '1 hour' WHERE id = $1`, [team.id]);
    const res = await app.inject({
      method: 'POST', url: '/api/teams/join-by-code',
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() },
      payload: { code: team.invite_code },
    });
    expect(res.statusCode).toBe(410);
  });

  test('rotating the code invalidates the old one', async () => {
    const leader = await makeUser();
    const joiner = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    const rot = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/invite/rotate`, headers: auth(leader.token) });
    expect(rot.statusCode).toBe(200);
    const oldTry = await app.inject({
      method: 'POST', url: '/api/teams/join-by-code',
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() },
      payload: { code: team.invite_code },
    });
    expect(oldTry.statusCode).toBe(404);
    const newTry = await app.inject({
      method: 'POST', url: '/api/teams/join-by-code',
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() },
      payload: { code: rot.json().invite_code },
    });
    expect(newTry.statusCode).toBe(201);
  });

  test('non-leader cannot rotate the code', async () => {
    const leader = await makeUser();
    const other = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    const res = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/invite/rotate`, headers: auth(other.token) });
    expect(res.statusCode).toBe(403);
  });
});

describe('team full and leave rules', () => {
  test('joining a full team is 409 team_full', async () => {
    const leader = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(`J${i}`);
      await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(u.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    }
    const extra = await makeUser('Extra');
    const res = await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(extra.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('team_full');
  });

  test('leader leaving passes leadership to the earliest member', async () => {
    const leader = await makeUser('Leader');
    const m1 = await makeUser('M1');
    const m2 = await makeUser('M2');
    const team = (await createTeam(leader.token)).json().team;
    for (const m of [m1, m2]) {
      await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(m.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    }
    const res = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(leader.token) });
    expect(res.json().team_deleted).toBe(false);
    const { rows } = await pool.query('SELECT leader_id FROM teams WHERE id = $1', [team.id]);
    expect(rows[0].leader_id).toBe(m1.id);
    const detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(m1.token) });
    expect(detail.json().members.find((x: any) => x.user_id === m1.id).role).toBe('leader');
  });

  test('last member leaving deletes the team; the code stops working', async () => {
    const leader = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    const res = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(leader.token) });
    expect(res.json().team_deleted).toBe(true);
    const other = await makeUser();
    const join = await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(other.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    expect(join.statusCode).toBe(404);
    const { rows } = await pool.query(`SELECT action FROM audit_log WHERE action = 'team_deleted'`);
    expect(rows.length).toBe(1);
  });

  test('leader can remove a member; non-leader cannot', async () => {
    const leader = await makeUser();
    const m = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(m.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    const forbidden = await app.inject({ method: 'DELETE', url: `/api/teams/${team.id}/members/${leader.id}`, headers: auth(m.token) });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({ method: 'DELETE', url: `/api/teams/${team.id}/members/${m.id}`, headers: auth(leader.token) });
    expect(ok.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(leader.token) });
    expect(detail.json().member_count).toBe(1);
  });
});

describe('join requests', () => {
  async function teamWithRequest() {
    const leader = await makeUser('Leader');
    const asker = await makeUser('Asker');
    const team = (await createTeam(leader.token)).json().team;
    const req = await app.inject({
      method: 'POST', url: `/api/teams/${team.id}/requests`,
      headers: { ...auth(asker.token), 'idempotency-key': idemKey() },
      payload: { message: 'I know React' },
    });
    return { leader, asker, team, request: req.json().request };
  }

  test('create request, leader sees it, duplicate is 409', async () => {
    const { leader, asker, team } = await teamWithRequest();
    const dup = await app.inject({
      method: 'POST', url: `/api/teams/${team.id}/requests`,
      headers: { ...auth(asker.token), 'idempotency-key': idemKey() }, payload: {},
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('request_already_pending');
    const detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(leader.token) });
    expect(detail.json().pending_requests.length).toBe(1);
  });

  test('non-leader cannot accept', async () => {
    const { asker, request } = await teamWithRequest();
    const res = await app.inject({ method: 'POST', url: `/api/requests/${request.id}/accept`, headers: auth(asker.token) });
    expect(res.statusCode).toBe(403);
  });

  test('accept adds the member and cancels their other pending requests', async () => {
    const { leader, asker, team, request } = await teamWithRequest();
    const otherLeader = await makeUser('OL');
    const otherTeam = (await createTeam(otherLeader.token, 'Other')).json().team;
    await app.inject({ method: 'POST', url: `/api/teams/${otherTeam.id}/requests`, headers: { ...auth(asker.token), 'idempotency-key': idemKey() }, payload: {} });
    const res = await app.inject({ method: 'POST', url: `/api/requests/${request.id}/accept`, headers: auth(leader.token) });
    expect(res.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(leader.token) });
    expect(detail.json().member_count).toBe(2);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM join_requests WHERE user_id = $1 AND status = 'pending'`, [asker.id]);
    expect(rows[0].n).toBe(0);
  });

  test('audit log separates actor (accepting leader) from subject (joined member)', async () => {
    const { leader, asker, team, request } = await teamWithRequest();
    await app.inject({ method: 'POST', url: `/api/requests/${request.id}/accept`, headers: auth(leader.token) });
    const audit = await app.inject({ method: 'GET', url: `/api/teams/${team.id}/audit`, headers: auth(leader.token) });
    expect(audit.statusCode).toBe(200);
    const joined = audit.json().audit.find((a: any) => a.action === 'member_joined');
    expect(joined).toBeTruthy();
    expect(joined.actor_name).toBe('Leader');
    expect(joined.subject_name).toBe('Asker');
    expect(joined.metadata.user_id).toBe(asker.id);
    expect(joined.metadata.user_id).not.toBe(leader.id);
  });

  test('declined request cannot later be accepted', async () => {
    const { leader, request } = await teamWithRequest();
    await app.inject({ method: 'POST', url: `/api/requests/${request.id}/decline`, headers: auth(leader.token) });
    const res = await app.inject({ method: 'POST', url: `/api/requests/${request.id}/accept`, headers: auth(leader.token) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('request_already_decided');
  });
});

describe('board, suggestions, metrics', () => {
  test('board lists only teams with open seats', async () => {
    const l1 = await makeUser('L1');
    const l2 = await makeUser('L2');
    await createTeam(l1.token, 'Open Team');
    const fullTeam = (await createTeam(l2.token, 'Full Team')).json().team;
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(`F${i}`);
      await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(u.token), 'idempotency-key': idemKey() }, payload: { code: fullTeam.invite_code } });
    }
    const viewer = await makeUser('Viewer');
    const res = await app.inject({ method: 'GET', url: '/api/board', headers: auth(viewer.token) });
    const names = res.json().teams.map((t: any) => t.name);
    expect(names).toContain('Open Team');
    expect(names).not.toContain('Full Team');
  });

  test('suggestions rank complementary skills first and explain the score', async () => {
    const me = await makeUser('Me', ['react'], 330);
    const comp = await makeUser('Backend Dev', ['node', 'postgres'], 330);   // 2 complementary
    const shared = await makeUser('Frontend Dev', ['react'], 330);           // 1 shared
    const far = await makeUser('Far Away', ['go'], -480);                    // tz mismatch
    const res = await app.inject({ method: 'GET', url: '/api/suggestions', headers: auth(me.token) });
    const s = res.json().suggestions;
    expect(res.json().scoring).toContain('complementary');
    expect(s[0].id).toBe(comp.id);
    expect(s[0].score).toBe(2 * 2 + 0 + 2);
    expect(s.find((x: any) => x.id === far.id).timezone_fit).toBe(0);
    expect(s.find((x: any) => x.id === shared.id).shared_skills).toBe(1);
  });

  test('suggestions exclude people already in a team', async () => {
    const me = await makeUser('Me', ['react']);
    const teamed = await makeUser('Teamed', ['node']);
    await createTeam(teamed.token, 'Taken');
    const res = await app.inject({ method: 'GET', url: '/api/suggestions', headers: auth(me.token) });
    expect(res.json().suggestions.map((x: any) => x.id)).not.toContain(teamed.id);
  });

  test('metrics endpoint reports request counts', async () => {
    const u = await makeUser();
    await app.inject({ method: 'GET', url: '/api/board', headers: auth(u.token) });
    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.json().routes['/api/board'].requests).toBeGreaterThan(0);
  });
});

describe('minimum team size semantics', () => {
  test('a team below min size exists and is flagged incomplete, not blocked', async () => {
    const u = await makeUser();
    const team = (await createTeam(u.token)).json().team; // min 2, creator alone
    const detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(u.token) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().member_count).toBe(1);
    expect(detail.json().is_complete).toBe(false);
  });

  test('team becomes complete at min size; leaving below min is allowed and re-flags it', async () => {
    const leader = await makeUser();
    const m = await makeUser();
    const team = (await createTeam(leader.token)).json().team;
    await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(m.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    let detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(leader.token) });
    expect(detail.json().is_complete).toBe(true);
    await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(m.token) });
    detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(leader.token) });
    expect(detail.json().is_complete).toBe(false);
  });

  test('board rows carry the completeness flag', async () => {
    const u = await makeUser();
    await createTeam(u.token, 'Incomplete Team');
    const v = await makeUser('Viewer');
    const res = await app.inject({ method: 'GET', url: '/api/board', headers: auth(v.token) });
    const row = res.json().teams.find((t: any) => t.name === 'Incomplete Team');
    expect(row.is_complete).toBe(false);
  });
});
