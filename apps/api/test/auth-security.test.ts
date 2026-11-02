import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';
import { signToken } from '../src/auth.js';

beforeAll(migrate);
beforeEach(() => resetDb());

const signup = (email: string, password: string, display_name = 'New User') =>
  app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password, display_name } });

describe('credential auth', () => {
  test('signup returns a working token and never the password hash', async () => {
    const res = await signup('Asha@Example.com', 'correct horse battery');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/password|\$2[aby]\$/);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(body.token) });
    expect(me.statusCode).toBe(200);
    expect(JSON.stringify(me.json())).not.toMatch(/\$2[aby]\$/);
    expect(me.json().profile.email).toBe('asha@example.com');
  });

  test('duplicate email (case-insensitive) gets 409, not 500', async () => {
    await signup('dup@example.com', 'password-one');
    const res = await signup('DUP@example.com', 'password-two');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('email_taken');
  });

  test('login with wrong password and unknown email both get the same 401', async () => {
    await signup('real@example.com', 'password-one');
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'real@example.com', password: 'password-two' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@example.com', password: 'password-two' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
  });

  test('good login returns a token', async () => {
    await signup('login@example.com', 'password-one');
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'LOGIN@example.com', password: 'password-one' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  test('short or invalid credentials get 400', async () => {
    expect((await signup('a@b.co', 'short')).statusCode).toBe(400);
    expect((await signup('not-an-email', 'long-enough-password')).statusCode).toBe(400);
  });

  test('auth endpoints are rate limited', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'rl@example.com', password: 'wrong-password' } });
      last = res.statusCode;
    }
    expect(last).toBe(429);
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
