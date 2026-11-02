import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam, testIdToken } from './helpers.js';
import { pool } from '../src/db.js';
import { signToken } from '../src/auth.js';

beforeAll(migrate);
beforeEach(() => resetDb());

const signup = (email: string, password: string, display_name = 'New User') =>
  app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password, display_name } });

describe('firebase credential exchange', () => {
  const fb = (email: string, display_name = 'New User', verified = true, uid?: string) =>
    app.inject({ method: 'POST', url: '/api/auth/firebase', payload: { id_token: testIdToken(email, verified, uid), display_name } });

  test('exchange returns a working token and no credential material', async () => {
    const res = await fb('Asha@Example.com');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/password|\$2[aby]\$/);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(body.token) });
    expect(me.statusCode).toBe(200);
    expect(JSON.stringify(me.json())).not.toMatch(/\$2[aby]\$/);
    expect(me.json().profile.email).toBe('asha@example.com');
    expect(me.json().profile.email_verified).toBe(true);
  });

  test('unverified Firebase email is rejected with 403 and creates no profile', async () => {
    const res = await fb('unv@example.com', 'Unverified', false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('email_unverified');
    const { rows } = await pool.query('SELECT 1 FROM profiles WHERE lower(email) = lower($1)', ['unv@example.com']);
    expect(rows.length).toBe(0);
  });

  test('garbage token is rejected with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/firebase', payload: { id_token: 'not-a-token' } });
    expect(res.statusCode).toBe(401);
  });

  test('email linked to a different Firebase uid is a 409, never silently re-linked', async () => {
    const first = await fb('same@example.com', 'First', true, 'uid-A');
    expect(first.statusCode).toBe(200);
    const second = await fb('SAME@example.com', 'Second', true, 'uid-B');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('email_taken');
    const { rows } = await pool.query('SELECT id, firebase_uid FROM profiles WHERE lower(email) = lower($1)', ['same@example.com']);
    expect(rows.length).toBe(1);
    expect(rows[0].firebase_uid).toBe('uid-A');
  });

  test('legacy unverified email profile is detached, never inherited: verified sign-in gets a fresh profile', async () => {
    // Legacy password-era profile: email was never verified; owns a team.
    const legacyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO profiles (id, display_name, email, password_hash) VALUES ($1, 'Legacy Owner', 'claim@example.com', 'stale-hash')`,
      [legacyId],
    );
    const res = await fb('claim@example.com', 'Real Owner', true, 'uid-real');
    expect(res.statusCode).toBe(200);
    const newId = res.json().user_id;
    expect(newId).not.toBe(legacyId); // no inheritance of the legacy identity
    const { rows: legacy } = await pool.query('SELECT email, firebase_uid, display_name FROM profiles WHERE id = $1', [legacyId]);
    expect(legacy[0].email).toBeNull(); // identifier released
    expect(legacy[0].firebase_uid).toBeNull(); // never linked
    const { rows: audit } = await pool.query(`SELECT 1 FROM audit_log WHERE actor_id = $1 AND action = 'legacy_email_detached'`, [legacyId]);
    expect(audit.length).toBe(1);
  });

  test('exchange endpoint is rate limited', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/firebase', payload: { id_token: testIdToken(`rl${i}@example.com`) } });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  test('retired password endpoints are gone', async () => {
    for (const url of ['/api/auth/signup', '/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/verify-email', '/api/auth/resend-verification']) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });

  test('offline test verifier is refused in production-like env', async () => {
    const prevVercel = process.env.VERCEL;
    process.env.VERCEL = '1';
    try {
      const { verifyFirebaseIdToken } = await import('../src/firebase.js');
      await expect(verifyFirebaseIdToken(testIdToken('prod@example.com'))).rejects.toThrow('forbidden in production');
    } finally {
      if (prevVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = prevVercel;
    }
  });
});

describe('JWT hardening', () => {
  test('expired token is rejected', async () => {
    const u = await makeUser();
    const expired = signToken(u.id, undefined, -10);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: auth(expired) });
    expect(res.statusCode).toBe(401);
  });

  test('token signed with a different secret is rejected', async () => {
    const u = await makeUser();
    const forged = jwt.sign({ sub: u.id, iss: 'teamform-api' }, 'attacker-secret', { expiresIn: '1h' });
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: auth(forged) });
    expect(res.statusCode).toBe(401);
  });

  test('token with wrong issuer is rejected', async () => {
    const u = await makeUser();
    const wrongIss = jwt.sign({ sub: u.id, iss: 'someone-else' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: auth(wrongIss) });
    expect(res.statusCode).toBe(401);
  });

  test('tampered payload (modified sub) is rejected', async () => {
    const u = await makeUser();
    const [h, p] = u.token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.sub = crypto.randomUUID();
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.AAAA`;
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: auth(tampered) });
    expect(res.statusCode).toBe(401);
  });
});

describe('per-user data access', () => {
  test('non-leader cannot accept/decline requests, rotate invite, or remove members', async () => {
    const leader = await makeUser('Leader');
    const outsider = await makeUser('Outsider');
    const joiner = await makeUser('Joiner');
    const team = await createTeam(leader.token, 'Guarded');
    const teamId = team.json().team.id;

    const req = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/requests`, headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: {} });
    expect(req.statusCode).toBe(201);
    const reqId = req.json().request.id;

    for (const attempt of [
      { method: 'POST' as const, url: `/api/requests/${reqId}/accept` },
      { method: 'POST' as const, url: `/api/requests/${reqId}/decline` },
      { method: 'POST' as const, url: `/api/teams/${teamId}/invite/rotate` },
      { method: 'DELETE' as const, url: `/api/teams/${teamId}/members/${joiner.id}` },
    ]) {
      const res = await app.inject({ ...attempt, headers: { ...auth(outsider.token), 'idempotency-key': idemKey() } });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }
  });

  test('non-member cannot read a team audit log', async () => {
    const leader = await makeUser('Leader2');
    const outsider = await makeUser('Outsider2');
    const team = await createTeam(leader.token, 'Audit');
    const res = await app.inject({ method: 'GET', url: `/api/teams/${team.json().team.id}/audit`, headers: auth(outsider.token) });
    expect(res.statusCode).toBe(403);
  });

  test('pending join requests are only visible to the leader', async () => {
    const leader = await makeUser('L3');
    const member = await makeUser('M3');
    const team = await createTeam(leader.token, 'PrivateReqs');
    const teamId = team.json().team.id;
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/requests`, headers: { ...auth(member.token), 'idempotency-key': idemKey() }, payload: {} });
    const asMember = await app.inject({ method: 'GET', url: `/api/teams/${teamId}`, headers: auth(member.token) });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json().pending_requests ?? []).toEqual([]);
    const asLeader = await app.inject({ method: 'GET', url: `/api/teams/${teamId}`, headers: auth(leader.token) });
    expect(asLeader.json().pending_requests.length).toBe(1);
  });
});
