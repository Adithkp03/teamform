import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, createTeam, auth, idemKey } from './helpers';
import { pool } from '../src/db.js';
import { pruneRateLimits } from '../src/ratelimit.js';
import { pruneIdempotencyKeys } from '../src/idempotency.js';

/** Retention bounds on the free DB: rate-limit windows and idempotency
 *  records prune to fixed horizons instead of growing forever. */

describe('retention prunes', () => {
  beforeEach(() => resetDb());

  it('pruneRateLimits removes windows closed >2h, keeps live windows', async () => {
    await pool.query(`INSERT INTO rate_limits (key, window_start, count) VALUES
      ('old', now() - interval '3 hours', 5), ('live', date_bin(make_interval(secs => 60), now(), timestamptz 'epoch'), 1)`);
    await pruneRateLimits();
    const { rows } = await pool.query(`SELECT key FROM rate_limits`);
    expect(rows.map((r: any) => r.key)).toEqual(['live']);
  });

  it('pruneIdempotencyKeys removes records older than 24h, keeps fresh ones', async () => {
    const u = await makeUser('U');
    await createTeam(u.token, 'Fresh Team'); // writes a fresh idempotency key
    await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, params_hash, state, updated_at)
       VALUES ('stale-key-000', $1, 'create_team', 'h', 'completed', now() - interval '2 days')`, [u.id]);
    await pruneIdempotencyKeys();
    const { rows } = await pool.query(`SELECT key FROM idempotency_keys`);
    expect(rows.map((r: any) => r.key)).not.toContain('stale-key-000');
    expect(rows.length).toBe(1); // the fresh create_team key survived
  });

  it('rateLimit still counts within a live window after a prune', async () => {
    const { rateLimit } = await import('../src/ratelimit.js');
    await pool.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ('old', now() - interval '3 hours', 5)`);
    await pruneRateLimits();
    for (let i = 0; i < 3; i++) await rateLimit('k', 3, 60);
    await expect(rateLimit('k', 3, 60)).rejects.toMatchObject({ statusCode: 429 });
  });
});
