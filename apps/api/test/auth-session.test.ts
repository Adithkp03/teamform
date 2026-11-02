import { beforeAll, beforeEach, afterEach, expect, test } from 'vitest';
import { app, migrate, resetDb, auth, idemKey, createTeam, makeUser, testIdToken } from './helpers.js';
import { setFirebaseTestHooks } from '../src/firebase.js';
import { pool } from '../src/db.js';
import { createHash } from 'node:crypto';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
import { signToken } from '../src/auth.js';

beforeAll(() => { migrate(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setFirebaseTestHooks(null, null); });

let seq = 0;
const uniq = (tag: string) => `${tag}-${Date.now()}-${seq++}@x.dev`;
const signup = (email: string, display_name = 'Tester') =>
  app.inject({ method: 'POST', url: '/api/auth/firebase', payload: { id_token: testIdToken(email), display_name } });

test('firebase exchange returns short-lived access + refresh tokens; repeat sign-in reuses the account', async () => {
  const email = uniq('a');
  const s = await signup(email);
  expect(s.statusCode).toBe(200);
  expect(s.json().token).toBeTruthy();
  expect(s.json().refresh_token).toBeTruthy();
  const l = await signup(email);
  expect(l.statusCode).toBe(200);
  expect(l.json().refresh_token).toBeTruthy();
  expect(l.json().user_id).toBe(s.json().user_id); // same Firebase uid, same profile
});

test('refresh rotates; within the grace window the old token still exchanges (multi-tab safe)', async () => {
  const s = await signup('rot@x.dev');
  const r1 = s.json().refresh_token;
  const r2res = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } });
  expect(r2res.statusCode).toBe(200);
  const { token: access2, refresh_token: r2 } = r2res.json();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(access2) });
  expect(me.statusCode).toBe(200);
  const r3 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r2 } });
  expect(r3.statusCode).toBe(200);
  // r1 re-presented inside the grace window: a fresh pair, NOT a lockout
  const grace = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } });
  expect(grace.statusCode).toBe(200);
  expect(grace.json().refresh_token).toBeTruthy();
});

test('two tabs refreshing the same token concurrently both succeed (no accidental lockout)', async () => {
  const s = await signup('tabs@x.dev');
  const r1 = s.json().refresh_token;
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } }),
    app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } }),
  ]);
  expect(a.statusCode).toBe(200);
  expect(b.statusCode).toBe(200);
  // both issued pairs are usable
  for (const res of [a, b]) {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(res.json().token) });
    expect(me.statusCode).toBe(200);
  }
});

test('after the grace window a rotated token is replay: 401 + all sessions revoked', async () => {
  const prev = process.env.REFRESH_GRACE_MS;
  process.env.REFRESH_GRACE_MS = '250';
  try {
    const s = await signup('replay@x.dev');
    const r1 = s.json().refresh_token;
    const r2 = (await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).json().refresh_token;
    await new Promise((r) => setTimeout(r, 400)); // past the window
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r2 } })).statusCode).toBe(401);
  } finally {
    if (prev === undefined) delete process.env.REFRESH_GRACE_MS; else process.env.REFRESH_GRACE_MS = prev;
  }
});

test('logout revokes immediately (no grace) and access tokens remain valid until expiry (documented)', async () => {
  const s = await signup('out2@x.dev');
  const { token: access, refresh_token: r } = s.json();
  await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refresh_token: r } });
  // refresh side dead at once
  expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r } })).statusCode).toBe(401);
  // the already-issued access token lives until its short expiry by design
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(access) });
  expect(me.statusCode).toBe(200);
});

test('replaying a rotated-away refresh token revokes every session (reuse detection)', async () => {
  const prev = process.env.REFRESH_GRACE_MS;
  process.env.REFRESH_GRACE_MS = '0';
  try {
  const s = await signup('reuse@x.dev');
  const r1 = s.json().refresh_token;
  const r2 = (await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).json().refresh_token;
  // attacker replays r1 -> all sessions revoked
  const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } });
  expect(replay.statusCode).toBe(401);
  const legit = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r2 } });
  expect(legit.statusCode).toBe(401);
  } finally {
    if (prev === undefined) delete process.env.REFRESH_GRACE_MS; else process.env.REFRESH_GRACE_MS = prev;
  }
});

test('logout revokes the refresh token; unknown token is a no-op', async () => {
  const s = await signup('out@x.dev');
  const r = s.json().refresh_token;
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refresh_token: r } });
  expect(out.statusCode).toBe(200);
  const use = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r } });
  expect(use.statusCode).toBe(401);
  const noop = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refresh_token: 'deadbeef'.repeat(8) } });
  expect(noop.statusCode).toBe(200);
});

test('expired access token is rejected with 401', async () => {
  const u = await makeUser('Exp');
  const short = signToken(u.id, undefined, '1ms');
  await new Promise((r) => setTimeout(r, 20));
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(short) });
  expect(me.statusCode).toBe(401);
});

test('profile PUT is rate limited at 20/min per user', async () => {
  const u = await makeUser('RL');
  let last = 0;
  for (let i = 0; i < 21; i++) {
    const res = await app.inject({
      method: 'PUT', url: '/api/me', headers: auth(u.token),
      payload: { display_name: 'RL', skills: [], timezone: 'UTC', utc_offset_minutes: 0, looking_for_team: true },
    });
    last = res.statusCode;
  }
  expect(last).toBe(429);
});

test('join-request creation is rate limited at 10/min per user', async () => {
  const owner = await makeUser('Owner');
  const team = await createTeam(owner.token, 'Limit FC');
  const teamId = team.json().team.id;
  const joiner = await makeUser('Joiner');
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const res = await app.inject({
      method: 'POST', url: `/api/teams/${teamId}/requests`,
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: {},
    });
    last = res.statusCode;
  }
  expect(last).toBe(429);
});

test('grace replay never branches the session family (multi-IP): one logout kills every grace-minted token', async () => {
  const s = await signup('family@x.dev');
  const old = s.json().refresh_token;
  const r1 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: old } });
  expect(r1.statusCode).toBe(200);
  // concurrent presentations of the SAME rotated token from different IPs
  // (distributed tabs, or an attacker racing): each rotates INSIDE the same
  // family - no independent persistent session is ever created
  const minted: string[] = [];
  for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', remoteAddress: ip, payload: { refresh_token: old } });
    expect(res.statusCode).toBe(200);
    minted.push(res.json().refresh_token);
  }
  expect(new Set(minted).size).toBe(3);
  // family correctness: logout with ONE grace-minted token revokes the whole
  // family - the legitimate rotation AND every grace sibling die together
  const lo = await app.inject({ method: 'POST', url: '/api/auth/logout', remoteAddress: '10.0.0.9', payload: { refresh_token: minted[0] } });
  expect(lo.statusCode).toBe(200);
  for (const t of [...minted.slice(1), r1.json().refresh_token]) {
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', remoteAddress: '10.0.0.8', payload: { refresh_token: t } })).statusCode).toBe(401);
  }
});

test('rotation inherits absolute family expiry - authority never extends', async () => {
  const s = await signup('abs@x.dev');
  const r1 = s.json().refresh_token;
  const exp1 = (await pool.query('SELECT expires_at FROM auth_refresh_tokens WHERE token_hash = $1', [sha(r1)])).rows[0].expires_at;
  const r2res = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } });
  expect(r2res.statusCode).toBe(200);
  const r2 = r2res.json().refresh_token;
  const exp2 = (await pool.query('SELECT expires_at FROM auth_refresh_tokens WHERE token_hash = $1', [sha(r2)])).rows[0].expires_at;
  expect(new Date(exp2).getTime()).toBe(new Date(exp1).getTime()); // no rolling renewal
});

test('grace window is anchored at the original rotation, not rolling', async () => {
  const prev = process.env.REFRESH_GRACE_MS;
  process.env.REFRESH_GRACE_MS = '250';
  try {
    const s = await signup('fixedwin@x.dev');
    const r1 = s.json().refresh_token;
    const r2 = (await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).json().refresh_token;
    await new Promise((r) => setTimeout(r, 100)); // still inside r1's window
    const r3res = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } });
    expect(r3res.statusCode).toBe(200); // grace re-rotation inside the family
    const r3 = r3res.json().refresh_token;
    await new Promise((r) => setTimeout(r, 300)); // past r1's ORIGINAL window
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).statusCode).toBe(401);
    // replay killed the whole family, including every grace-minted sibling
    for (const t of [r2, r3]) {
      expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: t } })).statusCode).toBe(401);
    }
  } finally {
    if (prev === undefined) delete process.env.REFRESH_GRACE_MS; else process.env.REFRESH_GRACE_MS = prev;
  }
});

test('logout racing rotation is atomic: no surviving token afterwards', async () => {
  const s = await signup('race@x.dev');
  const r1 = s.json().refresh_token;
  const [lo, rot] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refresh_token: r1 } }),
    app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } }),
  ]);
  // whichever won, the end state is a dead family: the old token and any
  // successor minted by a winning rotation are both unusable
  expect([200, 401]).toContain(rot.statusCode);
  if (rot.statusCode === 200) {
    const r2 = rot.json().refresh_token;
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r2 } })).statusCode).toBe(401);
  }
  expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).statusCode).toBe(401);
});

test('logout after rotation kills the family: a grace replay cannot resurrect it', async () => {
  const prev = process.env.REFRESH_GRACE_MS;
  process.env.REFRESH_GRACE_MS = '30000';
  try {
    const s = await signup('deadfam@x.dev');
    const r1 = s.json().refresh_token;
    // rotation wins first, then an explicit logout - deterministic order
    const r2 = (await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).json().refresh_token;
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refresh_token: r2 } })).statusCode).toBe(200);
    // r1 is still inside its grace window, but the family is dead: no resurrection
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r2 } })).statusCode).toBe(401);
  } finally {
    if (prev === undefined) delete process.env.REFRESH_GRACE_MS; else process.env.REFRESH_GRACE_MS = prev;
  }
});

test('firebase password reset/change invalidates app sessions at next rotation', async () => {
  const email = uniq('revoke');
  const uid = `test-${email}`;
  const s = await signup(email);
  expect(s.statusCode).toBe(200);
  const r1 = s.json().refresh_token;
  // rotation works while Firebase shows no revocation
  const ok = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } });
  expect(ok.statusCode).toBe(200);
  const r2 = ok.json().refresh_token;
  // Firebase reports a credential reset AFTER the session family started
  setFirebaseTestHooks(null, async (u) => (u === uid ? Date.now() / 1000 + 60 : null));
  expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r2 } })).statusCode).toBe(401);
  // whole family dead: the just-minted successor cannot continue either
  const r3 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1 } });
  expect(r3.statusCode).toBe(401);
  // a fresh sign-in after the "reset" still works
  setFirebaseTestHooks(null, null);
  expect((await signup(email)).statusCode).toBe(200);
});
