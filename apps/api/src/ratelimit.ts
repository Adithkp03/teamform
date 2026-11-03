import { pool } from './db.js';
import { errors } from './errors.js';

/**
 * Fixed-window rate limiting without Redis: one row per (key, window), atomically
 * incremented. Invite-code redemption and team creation are the abuse targets
 * (brute force, spam teams), so those are what we limit.
 */
/** Delete windows closed for >2h. Windows are 60s, so this loses nothing a
 *  live limiter decision could still need; exported for direct testing. */
export async function pruneRateLimits(): Promise<void> {
  await pool.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'`);
}

export async function rateLimit(key: string, limit: number, windowSeconds = 60): Promise<void> {
  // Bounded storage on the free DB: probabilistic self-prune (~2% of calls)
  // keeps one row per active key/window instead of unbounded growth.
  if (Math.random() < 0.02) pruneRateLimits().catch(() => {});
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, date_bin(make_interval(secs => $2::int), now(), timestamptz 'epoch'), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowSeconds],
  );
  if (rows[0].count > limit) throw errors.tooMany();
}
