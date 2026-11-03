import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, migrate, resetDb, makeUser, makeEmailUser, auth } from './helpers.js';
import { pool } from '../src/db.js';
import { flushToDb } from '../src/metrics.js';

/** Durable operational telemetry: in-process counters die with each serverless
 *  instance, so deltas are upserted into 5-minute rollups with a 14-day
 *  retention. Route keys must be Fastify templates, never concrete IDs. */

beforeAll(migrate);

describe('metrics rollups', () => {
  beforeEach(() => resetDb());

  it('flush persists per-route rollups keyed by route template (no concrete IDs/PII)', async () => {
    const u = await makeUser('U');
    const uuid = crypto.randomUUID();
    await app.inject({ method: 'GET', url: `/api/teams/${uuid}`, headers: auth(u.token) });
    await app.inject({ method: 'GET', url: '/api/board', headers: auth(u.token) });
    await flushToDb();
    const { rows } = await pool.query(`SELECT route, requests FROM metrics_rollups`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.route).not.toContain(uuid);
      expect(r.route).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    expect(rows.map((r: any) => r.route)).toContain('/api/teams/:id');
    expect(rows.find((r: any) => r.route === '/api/board').requests).toBeGreaterThan(0);
  });

  it('a flush with no new traffic writes nothing new', async () => {
    const u = await makeUser('U');
    await app.inject({ method: 'GET', url: '/api/board', headers: auth(u.token) });
    expect(await flushToDb()).toBeGreaterThan(0);
    const { rows: before } = await pool.query(`SELECT count(*)::int AS c FROM metrics_rollups`);
    expect(await flushToDb()).toBe(0);
    const { rows: after } = await pool.query(`SELECT count(*)::int AS c FROM metrics_rollups`);
    expect(after[0].c).toBe(before[0].c);
  });

  it('flush prunes rollups older than 14 days, keeps recent ones', async () => {
    await pool.query(`INSERT INTO metrics_rollups (window_start, route, requests) VALUES
      (now() - interval '15 days', '/api/old', 9), (now() - interval '1 hour', '/api/new', 1)`);
    await flushToDb();
    const { rows } = await pool.query(`SELECT route FROM metrics_rollups`);
    expect(rows.map((r: any) => r.route)).not.toContain('/api/old');
    expect(rows.map((r: any) => r.route)).toContain('/api/new');
  });

  it('organizer metrics response includes the durable 24h aggregation', async () => {
    const savedEnv = process.env.ORGANIZER_EMAILS;
    process.env.ORGANIZER_EMAILS = 'rollup-org@test.dev';
    try {
      const u = await makeUser('U2');
      await app.inject({ method: 'GET', url: '/api/board', headers: auth(u.token) });
      const org = await makeEmailUser('Org', 'rollup-org@test.dev');
      const res = await app.inject({ method: 'GET', url: '/api/metrics', headers: auth(org.token) });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().durable_24h)).toBe(true);
      const board = res.json().durable_24h.find((r: any) => r.route === '/api/board');
      expect(board.requests).toBeGreaterThan(0);
    } finally {
      if (savedEnv === undefined) delete process.env.ORGANIZER_EMAILS; else process.env.ORGANIZER_EMAILS = savedEnv;
    }
  });
});
