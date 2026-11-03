import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';
import { pool } from '../src/db.js';
import { issueActionToken } from '../src/auth.js';
import { mailOutbox } from '../src/mailer.js';

beforeAll(migrate);
beforeEach(() => resetDb());

// Real user journeys and edge cases beyond the happy path: invite expiry,
// leadership change while moderation is pending, and the legacy
// signup -> verify -> reset arc.

describe('invite expiry journey', () => {
  test('expired codes are refused (410), rotation issues a fresh valid code', async () => {
    // Zero-TTL event: codes are born expired.
    await pool.query(`UPDATE hackathons SET invite_code_ttl_minutes = 0`);
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token, 'Expiring Team')).json().team;
    const joiner = await makeUser('Joiner');
    const expired = await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    expect(expired.statusCode).toBe(410);

    // Organizer fixes the TTL; the leader rotates; the new code works.
    await pool.query(`UPDATE hackathons SET invite_code_ttl_minutes = 60`);
    const rotated = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/invite/rotate`, headers: { ...auth(leader.token), 'idempotency-key': idemKey() } });
    expect(rotated.statusCode).toBe(200);
    const joined = await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: { code: rotated.json().invite_code } });
    expect(joined.statusCode).toBe(201);
  });
});

describe('leader departure while moderation is pending', () => {
  test('old leader loses moderation rights instantly; new leader can accept', async () => {
    const leader = await makeUser('Old Leader');
    const member = await makeUser('Member');
    const outsider = await makeUser('Outsider');
    const team = (await createTeam(leader.token, 'Transition Team')).json().team;
    await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(member.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    const jr = (await app.inject({ method: 'POST', url: `/api/teams/${team.id}/requests`, headers: { ...auth(outsider.token), 'idempotency-key': idemKey() }, payload: {} })).json().request;

    // Leader leaves mid-moderation: leadership passes to the earliest member.
    const left = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(leader.token) });
    expect(left.statusCode).toBe(200);
    expect(left.json().team_deleted).toBe(false);

    const oldLeader = await app.inject({ method: 'POST', url: `/api/requests/${jr.id}/accept`, headers: auth(leader.token) });
    expect(oldLeader.statusCode).toBe(403);

    const newLeader = await app.inject({ method: 'POST', url: `/api/requests/${jr.id}/accept`, headers: auth(member.token) });
    expect(newLeader.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(member.token) });
    expect(detail.json().members.map((m: any) => m.user_id)).toContain(outsider.id);
    expect(detail.json().team.leader_id).toBe(member.id);
  });
});

describe('legacy signup -> verify -> reset arc', () => {
  test('verification mail link is single-use; reset revokes sessions and old password', async () => {
    const signup = await app.inject({
      method: 'POST', url: '/api/auth/signup',
      payload: { email: 'journey@test.dev', password: 'correct horse battery', display_name: 'Journey' },
    });
    expect(signup.statusCode).toBe(200);
    const { refresh_token, token: access } = signup.json();

    // The 'log' mail provider exposes exactly what would be emailed.
    const mail = mailOutbox().filter((m) => m.to === 'journey@test.dev' && m.kind === 'verify').pop();
    expect(mail).toBeTruthy();
    const verifyToken = new URL(mail!.url).searchParams.get('token')!;
    const v1 = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: verifyToken } });
    expect(v1.statusCode).toBe(200);
    const v2 = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: verifyToken } });
    expect(v2.statusCode).toBe(401); // single-use

    // Reset: issue + consume, then old session and old password are dead.
    const forgot = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'journey@test.dev' } });
    expect(forgot.statusCode).toBe(200);
    const resetMail = mailOutbox().filter((m) => m.to === 'journey@test.dev' && m.kind === 'reset').pop();
    const resetToken = new URL(resetMail!.url).searchParams.get('token')!;
    const reset = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: resetToken, password: 'new password 123' } });
    expect(reset.statusCode).toBe(200);

    const oldRefresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token } });
    expect(oldRefresh.statusCode).toBe(401);
    const oldLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'journey@test.dev', password: 'correct horse battery' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'journey@test.dev', password: 'new password 123' } });
    expect(newLogin.statusCode).toBe(200);
    void access;
  });

  test('action tokens expire and reset is single-use', async () => {
    const u = await makeUser('TokenUser');
    const t = await issueActionToken(u.id, 'reset');
    const ok = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: t, password: 'irrelevant 123' } });
    expect(ok.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: t, password: 'irrelevant 456' } });
    expect(replay.statusCode).toBe(401);
    // Force-expired token is refused.
    const t2 = await issueActionToken(u.id, 'verify');
    await pool.query(`UPDATE auth_action_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = encode(digest($1, 'sha256'), 'hex')`, [t2]);
    const expired = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: t2 } });
    expect(expired.statusCode).toBe(401);
  });
});
