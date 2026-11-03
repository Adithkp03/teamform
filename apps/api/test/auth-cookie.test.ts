import { beforeAll, beforeEach, expect, test } from 'vitest';
import { app, migrate, resetDb, auth, testIdToken, testRefreshToken } from './helpers.js';

// HttpOnly session-cookie mode: the long-lived refresh token moves out of
// JS-readable storage into a SameSite=Lax cookie scoped to /api/auth, with an
// Origin allowlist as CSRF defense-in-depth. Body-token mode stays for legacy
// clients, CLI use and the e2e seam.
beforeAll(() => { migrate(); });
beforeEach(async () => { await resetDb(); });

let seq = 0;
const uniq = (tag: string) => `${tag}-${Date.now()}-${seq++}@x.dev`;
const exchange = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/firebase',
    payload: { id_token: testIdToken(email), firebase_refresh_token: testRefreshToken(email), display_name: 'Tester' },
  });
const cookieOf = (res: any): string | null => {
  const sc = res.headers['set-cookie'];
  const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
  return list.find((c: string) => c.startsWith('tf_rt=')) ?? null;
};
const cookieToken = (res: any): string => cookieOf(res)!.match(/^tf_rt=([0-9a-f]{64})/)![1];

test('firebase exchange sets an HttpOnly session cookie and flags cookie_set', async () => {
  const res = await exchange(uniq('c'));
  expect(res.statusCode).toBe(200);
  const cookie = cookieOf(res);
  expect(cookie).toBeTruthy();
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  expect(cookie).toContain('Path=/api/auth');
  expect(cookie).toContain('Max-Age=2592000');
  expect(cookie).not.toContain('Secure'); // test env is not production-like
  expect(res.json().cookie_set).toBe(true);
  // Legacy body mode is still served during the client rollout window.
  expect(res.json().refresh_token).toBeTruthy();
});

test('refresh works with the cookie alone and rotates it', async () => {
  const s = await exchange(uniq('rot'));
  const c1 = cookieToken(s);
  const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {}, headers: { cookie: `tf_rt=${c1}` } });
  expect(r.statusCode).toBe(200);
  expect(r.json().cookie_set).toBe(true);
  const c2 = cookieToken(r);
  expect(c2).toBeTruthy();
  expect(c2).not.toBe(c1);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(r.json().token) });
  expect(me.statusCode).toBe(200);
});

test('cookie-authenticated refresh rejects a disallowed Origin and allows a configured one', async () => {
  const s = await exchange(uniq('csrf'));
  const c1 = cookieToken(s);
  const bad = await app.inject({
    method: 'POST', url: '/api/auth/refresh', payload: {},
    headers: { cookie: `tf_rt=${c1}`, origin: 'https://evil.example' },
  });
  expect(bad.statusCode).toBe(403);
  const good = await app.inject({
    method: 'POST', url: '/api/auth/refresh', payload: {},
    headers: { cookie: `tf_rt=${c1}`, origin: 'http://localhost:3101' },
  });
  expect(good.statusCode).toBe(200);
});

test('legacy upgrade: a body-token refresh mints the cookie; the cookie then rotates the session', async () => {
  const s = await exchange(uniq('up'));
  const rt = s.json().refresh_token;
  const r1 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: rt } });
  expect(r1.statusCode).toBe(200);
  expect(cookieToken(r1)).toBeTruthy();
  const r2 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {}, headers: { cookie: `tf_rt=${cookieToken(r1)}` } });
  expect(r2.statusCode).toBe(200);
});

test('an explicit body token wins over a cookie (legacy clients mid-upgrade)', async () => {
  const s = await exchange(uniq('dual'));
  const rt = s.json().refresh_token;
  const r = await app.inject({
    method: 'POST', url: '/api/auth/refresh',
    payload: { refresh_token: rt }, headers: { cookie: 'tf_rt=garbage-not-a-token' },
  });
  expect(r.statusCode).toBe(200);
});

test('logout with the cookie alone revokes the family and clears the cookie', async () => {
  const s = await exchange(uniq('out'));
  const c1 = cookieToken(s);
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers: { cookie: `tf_rt=${c1}` } });
  expect(out.statusCode).toBe(200);
  expect(cookieOf(out)).toContain('Max-Age=0');
  const again = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {}, headers: { cookie: `tf_rt=${c1}` } });
  expect(again.statusCode).toBe(401);
});

test('logout revokes BOTH a diverged body token and cookie (post-upgrade tab mix)', async () => {
  // Simulate: tab A still holds an older body token while tab B upgraded to
  // the cookie - they briefly name different live tokens of one family.
  const s = await exchange(uniq('mix'));
  const rtA = s.json().refresh_token;
  const r1 = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: rtA } });
  const cB = cookieToken(r1); // tab B's cookie
  const out = await app.inject({
    method: 'POST', url: '/api/auth/logout',
    payload: { refresh_token: rtA }, headers: { cookie: `tf_rt=${cB}` },
  });
  expect(out.statusCode).toBe(200);
  // The whole family is dead: neither the cookie nor the rotated body token refreshes.
  const viaCookie = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {}, headers: { cookie: `tf_rt=${cB}` } });
  expect(viaCookie.statusCode).toBe(401);
  const viaBody = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: r1.json().refresh_token } });
  expect(viaBody.statusCode).toBe(401);
});

test('no body and no cookie is a clean 401; logout without credentials is a no-op', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {} });
  expect(r.statusCode).toBe(401);
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {} });
  expect(out.statusCode).toBe(200);
});
