import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app, resetDb, makeUser, makeEmailUser, auth } from './helpers';
import { buildApp } from '../src/app.js';

/** Security defaults fail closed: CORS requires explicit origins in
 *  production-like environments; /api/metrics is organizer-only; every
 *  response carries the security-header set. */

describe('CORS boot policy', () => {
  const saved: Record<string, string | undefined> = {};
  afterAll(() => {
    for (const k of ['VERCEL', 'CORS_ORIGIN', 'NODE_ENV']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('refuses to boot production-like without CORS_ORIGIN, boots with it', () => {
    saved.VERCEL = process.env.VERCEL; saved.CORS_ORIGIN = process.env.CORS_ORIGIN; saved.NODE_ENV = process.env.NODE_ENV;
    process.env.VERCEL = '1'; delete process.env.CORS_ORIGIN;
    expect(() => buildApp()).toThrow(/CORS_ORIGIN/);
    process.env.CORS_ORIGIN = 'https://teamform-web.vercel.app';
    expect(() => buildApp()).not.toThrow();
    delete process.env.VERCEL;
  });

  it('dev default allows local origins only, never a wildcard reflection', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    const ok = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost:5173' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('/api/metrics is organizer-only', () => {
  beforeEach(() => resetDb());

  it('401 without a token, 403 for a regular user, 200 for a verified allowlisted organizer', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(anon.statusCode).toBe(401);

    const user = await makeUser('Plain');
    const forbidden = await app.inject({ method: 'GET', url: '/api/metrics', headers: auth(user.token) });
    expect(forbidden.statusCode).toBe(403);

    const savedEnv = process.env.ORGANIZER_EMAILS;
    process.env.ORGANIZER_EMAILS = 'org@test.dev';
    try {
      const org = await makeEmailUser('Org', 'org@test.dev');
      const okRes = await app.inject({ method: 'GET', url: '/api/metrics', headers: auth(org.token) });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toHaveProperty('db_pool');
    } finally {
      if (savedEnv === undefined) delete process.env.ORGANIZER_EMAILS; else process.env.ORGANIZER_EMAILS = savedEnv;
    }
  });
});

describe('security headers', () => {
  it('every response carries nosniff, frame denial, no-referrer and a locked-down CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
