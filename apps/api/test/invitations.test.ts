import { describe, it, expect, beforeEach } from 'vitest';
import { app, resetDb, makeUser, createTeam, auth, idemKey } from './helpers';
import { pool } from '../src/db.js';

/**
 * Team invitations (the outbound connect journey) + requester self-cancel.
 * Invariants mirror join requests: one pending per (team, person), accept
 * takes a real seat under the team row lock, membership cancels every other
 * pending ask/offer, and everything is audited.
 */

async function makeLookingUser(name: string, tz = 'UTC') {
  const u = await makeUser(name);
  await pool.query(`UPDATE profiles SET looking_for_team = true, timezone = $2 WHERE id = $1`, [u.id, tz]);
  return u;
}

async function invite(token: string, teamId: string, userId: string) {
  return app.inject({
    method: 'POST', url: `/api/teams/${teamId}/invitations`,
    headers: { ...auth(token), 'idempotency-key': idemKey() },
    payload: { user_id: userId },
  });
}

describe('team invitations', () => {
  beforeEach(() => resetDb());

  it('member invites a looking person; invitee sees it and accepts; both see membership', async () => {
    const leader = await makeUser('Lead');
    const guest = await makeLookingUser('Guest', 'Asia/Calcutta');
    const teamId = (await (await createTeam(leader.token, 'Rocket')).json()).team.id as string;

    const inv = await invite(leader.token, teamId, guest.id);
    expect(inv.statusCode).toBe(201);

    const inbox = await app.inject({ method: 'GET', url: '/api/me/invitations', headers: auth(guest.token) });
    expect(inbox.json().invitations).toHaveLength(1);
    expect(inbox.json().invitations[0]).toMatchObject({ team_id: teamId, team_name: 'Rocket', member_count: 1, invited_by_name: 'Lead' });

    const invId = inbox.json().invitations[0].id;
    const acc = await app.inject({ method: 'POST', url: `/api/invitations/${invId}/accept`, headers: auth(guest.token) });
    expect(acc.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/teams/${teamId}`, headers: auth(leader.token) });
    expect(detail.json().member_count).toBe(2);
    expect(detail.json().members.map((m: any) => m.user_id)).toContain(guest.id);

    const audit = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/audit`, headers: auth(leader.token) });
    const actions = audit.json().audit.map((a: any) => a.action);
    expect(actions).toContain('member_invited');
    expect(actions).toContain('member_joined');
  });

  it('accept cancels the invitee\'s other pending requests and invitations, each audited', async () => {
    const a = await makeUser('A'); const b = await makeUser('B'); const c = await makeUser('C');
    const guest = await makeLookingUser('Guest');
    const tA = (await (await createTeam(a.token, 'Alpha')).json()).team.id as string;
    const tB = (await (await createTeam(b.token, 'Beta')).json()).team.id as string;
    const tC = (await (await createTeam(c.token, 'Gamma')).json()).team.id as string;

    // guest asks C, gets invited by A and B
    await app.inject({ method: 'POST', url: `/api/teams/${tC}/requests`, headers: { ...auth(guest.token), 'idempotency-key': idemKey() }, payload: {} });
    await invite(a.token, tA, guest.id);
    await invite(b.token, tB, guest.id);
    const inbox = await app.inject({ method: 'GET', url: '/api/me/invitations', headers: auth(guest.token) });
    const invA = inbox.json().invitations.find((i: any) => i.team_id === tA);

    await app.inject({ method: 'POST', url: `/api/invitations/${invA.id}/accept`, headers: auth(guest.token) });

    // B's invitation and the request to C are gone from pending state
    const inbox2 = await app.inject({ method: 'GET', url: '/api/me/invitations', headers: auth(guest.token) });
    expect(inbox2.json().invitations).toHaveLength(0);
    const { rows } = await pool.query(`SELECT status FROM join_requests WHERE user_id = $1`, [guest.id]);
    expect(rows).toEqual([{ status: 'cancelled' }]);
    const { rows: invs } = await pool.query(`SELECT status FROM team_invitations WHERE user_id = $1 ORDER BY created_at`, [guest.id]);
    expect(invs.map((r: any) => r.status)).toEqual(['accepted', 'cancelled']);
  });

  it('rejects: self-invite, inviting a non-looking or teamed person, duplicate pending, non-member inviter, invite to full team', async () => {
    const leader = await makeUser('Lead');
    const outsider = await makeUser('Outsider');
    const notLooking = await makeUser('Shy');
    await pool.query(`UPDATE profiles SET looking_for_team = false WHERE id = $1`, [notLooking.id]);
    const teamed = await makeUser('Teamed');
    const guest = await makeLookingUser('Guest');
    const teamId = (await (await createTeam(leader.token, 'Rocket')).json()).team.id as string;
    await createTeam(teamed.token, 'Theirs');

    expect((await invite(leader.token, teamId, leader.id)).statusCode).toBe(400);
    expect((await invite(leader.token, teamId, notLooking.id)).statusCode).toBe(404);
    expect((await invite(leader.token, teamId, teamed.id)).json().error.code).toBe('already_in_team');
    expect((await invite(outsider.token, teamId, guest.id)).statusCode).toBe(403);

    expect((await invite(leader.token, teamId, guest.id)).statusCode).toBe(201);
    const dup = await invite(leader.token, teamId, guest.id);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('invitation_already_pending');

    // full team cannot invite (min=max=1 via resetDb opts not needed: fill to max 4)
    const fillers = await Promise.all([makeLookingUser('F1'), makeLookingUser('F2'), makeLookingUser('F3')]);
    for (const f of fillers) {
      await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(f.token), 'idempotency-key': idemKey() }, payload: { code: (await app.inject({ method: 'GET', url: `/api/teams/${teamId}`, headers: auth(leader.token) })).json().team.invite_code } });
    }
    const extra = await makeLookingUser('Extra');
    expect((await invite(leader.token, teamId, extra.id)).json().error.code).toBe('team_full');
  });

  it('a pending join request beats a redundant invitation', async () => {
    const leader = await makeUser('Lead');
    const guest = await makeLookingUser('Guest');
    const teamId = (await (await createTeam(leader.token, 'Rocket')).json()).team.id as string;
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/requests`, headers: { ...auth(guest.token), 'idempotency-key': idemKey() }, payload: {} });
    const res = await invite(leader.token, teamId, guest.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_requested');
  });

  it('accept when the team filled after the invite cancels the invitation and returns team_full', async () => {
    const leader = await makeUser('Lead');
    const guest = await makeLookingUser('Guest');
    const teamId = (await (await createTeam(leader.token, 'Rocket')).json()).team.id as string;
    const invId = (await (await invite(leader.token, teamId, guest.id)).json()).invitation.id as string;

    // fill the other 3 seats via invite code
    const code = (await app.inject({ method: 'GET', url: `/api/teams/${teamId}`, headers: auth(leader.token) })).json().team.invite_code;
    for (const n of ['F1', 'F2', 'F3']) {
      const f = await makeLookingUser(n);
      await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(f.token), 'idempotency-key': idemKey() }, payload: { code } });
    }

    const acc = await app.inject({ method: 'POST', url: `/api/invitations/${invId}/accept`, headers: auth(guest.token) });
    expect(acc.statusCode).toBe(409);
    expect(acc.json().error.code).toBe('team_full');
    const { rows } = await pool.query(`SELECT status FROM team_invitations WHERE id = $1`, [invId]);
    expect(rows[0].status).toBe('cancelled');
    // guest is still teamless and can act on it
    const { rows: tm } = await pool.query(`SELECT 1 FROM team_members WHERE user_id = $1`, [guest.id]);
    expect(tm).toHaveLength(0);
  });

  it('accept by the wrong person is forbidden; double accept is a clean conflict', async () => {
    const leader = await makeUser('Lead');
    const guest = await makeLookingUser('Guest');
    const other = await makeUser('Other');
    const teamId = (await (await createTeam(leader.token, 'Rocket')).json()).team.id as string;
    const invId = (await (await invite(leader.token, teamId, guest.id)).json()).invitation.id as string;

    expect((await app.inject({ method: 'POST', url: `/api/invitations/${invId}/accept`, headers: auth(other.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/invitations/${invId}/accept`, headers: auth(guest.token) })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/api/invitations/${invId}/accept`, headers: auth(guest.token) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invitation_already_decided');
  });

  it('decline and withdraw paths work and are audited; stranger cannot withdraw', async () => {
    const leader = await makeUser('Lead');
    const member = await makeUser('Member');
    const stranger = await makeUser('Stranger');
    const g1 = await makeLookingUser('G1');
    const g2 = await makeLookingUser('G2');
    const teamId = (await (await createTeam(leader.token, 'Rocket')).json()).team.id as string;
    const code = (await app.inject({ method: 'GET', url: `/api/teams/${teamId}`, headers: auth(leader.token) })).json().team.invite_code;
    await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(member.token), 'idempotency-key': idemKey() }, payload: { code } });

    // member invites g1; g1 declines
    const inv1 = (await (await invite(member.token, teamId, g1.id)).json()).invitation.id as string;
    expect((await app.inject({ method: 'POST', url: `/api/invitations/${inv1}/decline`, headers: auth(g1.token) })).statusCode).toBe(200);

    // member invites g2; stranger cannot withdraw; inviter can
    const inv2 = (await (await invite(member.token, teamId, g2.id)).json()).invitation.id as string;
    expect((await app.inject({ method: 'DELETE', url: `/api/invitations/${inv2}`, headers: auth(stranger.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/invitations/${inv2}`, headers: auth(member.token) })).statusCode).toBe(200);

    const pending = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/invitations`, headers: auth(leader.token) });
    expect(pending.json().invitations).toHaveLength(0);
    const audit = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/audit`, headers: auth(leader.token) });
    const actions = audit.json().audit.map((a: any) => a.action);
    expect(actions).toContain('invitation_declined');
    expect(actions).toContain('invitation_cancelled');
  });
});

describe('requester cancels their own pending request', () => {
  beforeEach(() => resetDb());

  it('cancel works once and is audited; strangers get 404; decided requests are not cancellable', async () => {
    const leader = await makeUser('Lead');
    const asker = await makeUser('Asker');
    const stranger = await makeUser('Stranger');
    const teamId = (await (await createTeam(leader.token, 'Rocket')).json()).team.id as string;

    const req = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/requests`, headers: { ...auth(asker.token), 'idempotency-key': idemKey() }, payload: {} });
    const reqId = req.json().request.id as string;

    expect((await app.inject({ method: 'DELETE', url: `/api/requests/${reqId}`, headers: auth(stranger.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/requests/${reqId}`, headers: auth(asker.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/requests/${reqId}`, headers: auth(asker.token) })).statusCode).toBe(404);

    const audit = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/audit`, headers: auth(leader.token) });
    expect(audit.json().audit.map((a: any) => a.action)).toContain('join_request_cancelled');
  });
});
