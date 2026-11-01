import { pool } from './db.js';
import { errors } from './errors.js';

/**
 * Fixed-window rate limiting without Redis: one row per (key, window), atomically
 * incremented. Invite-code redemption and team creation are the abuse targets
 * (brute force, spam teams), so those are what we limit.
 */
export async function rateLimit(key: string, limit: number, windowSeconds = 60): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, date_bin(make_interval(secs => $2::int), now(), timestamptz 'epoch'), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowSeconds],
  );
  if (rows[0].count > limit) throw errors.tooMany();
}
