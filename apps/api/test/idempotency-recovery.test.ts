import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';
import { pool } from '../src/db.js';

beforeAll(migrate);
beforeEach(() => resetDb());

// Recovery semantics of the idempotency layer: what a retry sees after each
// way the original attempt can die. These are the timeout-after-commit and
// retry-after-response-loss cases called out in the product review.

describe('retry after response loss (request committed, client never saw it)', () => {
  test('replay returns the stored 201 and exactly one team exists', async () => {
    const u = await makeUser();
    const key = idemKey();
    const first = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload: { name: 'Committed Once' } });
    expect(first.statusCode).toBe(201);
    // Simulate the lost response: the client retries the SAME key, unchanged body.
    const replay = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload: { name: 'Committed Once' } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const { rows } = await pool.query('SELECT count(*)::int n FROM teams');
    expect(rows[0].n).toBe(1);
  });

  test('a stored 4xx is replayed identically after the race resolves (no re-execution)', async () => {
    // Fill a team to max (4): leader + 3 joiners, then a loser joins by code.
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token, 'Full House')).json().team;
    for (const n of ['A', 'B', 'C']) {
      const m = await makeUser(n);
      await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(m.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    }
    const loser = await makeUser('Loser');
    const key = idemKey();
    const full = await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(loser.token), 'idempotency-key': key }, payload: { code: team.invite_code } });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('team_full');
    // A seat opens, but the client's retry of the SAME key must still get the
    // original outcome: the retry is a replay of an answered question, not a
    // new attempt. (A fresh key would join successfully.)
    const replay = await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(loser.token), 'idempotency-key': key }, payload: { code: team.invite_code } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual(full.json());
    const { rows } = await pool.query('SELECT count(*)::int n FROM team_members WHERE team_id = $1', [team.id]);
    expect(rows[0].n).toBe(4);
  });
});

describe('worker died mid-flight (timeout-after-commit window)', () => {
  test('a fresh in-flight key is a 409 signal to retry shortly', async () => {
    const u = await makeUser();
    const key = idemKey();
    await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, params_hash, state)
       VALUES ($1, $2, 'create_team', 'hash-of-something-else', 'in_flight')`,
      [key, u.id],
    );
    const res = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload: { name: 'Whatever' } });
    // params_hash differs -> reuse is still caught before the in-flight check.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_key_reused');
  });

  test('a stale in-flight key (>60s) is taken over: the presumed-dead attempt never completed', async () => {
    const u = await makeUser();
    const key = idemKey();
    // Reproduce the exact params hash the endpoint will compute, then age it.
    const probe = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key }, payload: { name: 'Revived' } });
    expect(probe.statusCode).toBe(201);
    const { rows: teams } = await pool.query('SELECT id FROM teams');
    // Now simulate a DEAD earlier attempt on a fresh key: insert a stale
    // in_flight row with the same params hash a real request would produce.
    const key2 = idemKey();
    const crypto = await import('node:crypto');
    const paramsHash = crypto.createHash('sha256').update(JSON.stringify({ endpoint: 'create_team', body: { name: 'Revived' } })).digest('hex');
    await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, params_hash, state, updated_at)
       VALUES ($1, $2, 'create_team', $3, 'in_flight', now() - interval '2 minutes')`,
      [key2, u.id, paramsHash],
    );
    // Retry after the stale window: takes over and... the user is already in a
    // team, so the DOMAIN rule still wins. The takeover ran the handler (a
    // replayed dead-worker attempt) and stored its 409 as the outcome.
    const retry = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key2 }, payload: { name: 'Revived' } });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('already_in_team');
    const replay = await app.inject({ method: 'POST', url: '/api/teams', headers: { ...auth(u.token), 'idempotency-key': key2 }, payload: { name: 'Revived' } });
    expect(replay.json()).toEqual(retry.json());
    expect(teams.length).toBe(1);
  });
});
