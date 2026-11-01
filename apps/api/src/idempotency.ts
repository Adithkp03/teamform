import crypto from 'node:crypto';
import { pool } from './db.js';
import { ApiError, errors } from './errors.js';

const STALE_MS = 60_000;

export interface HandlerResult {
  status: number;
  body: unknown;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/**
 * Stripe-style idempotency for mutating endpoints.
 *
 * The idempotency_keys row IS the lock: the first INSERT wins the right to run.
 * A retry then sees:
 *   - completed + same params -> the stored response (no double effects)
 *   - completed + different params -> 409 idempotency_key_reused
 *   - in_flight, fresh -> 409 request_in_flight (the client retries with the same key)
 *   - in_flight, stale (>60s) -> the retry takes over (original worker presumed dead)
 * Handler outcomes (including 4xx) are stored as the completed response, so a
 * replayed race-loser returns the same 409 instead of re-running.
 */
export function idempotent(
  endpoint: string,
  handler: (req: any) => Promise<HandlerResult>,
) {
  return async (req: any, reply: any) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key) {
      // Idempotency is opt-in for clients; DB invariants still guarantee correctness.
      const result = await handler(req);
      reply.code(result.status);
      return result.body;
    }
    if (key.length < 8 || key.length > 128) {
      throw errors.badRequest('Idempotency-Key must be 8-128 characters');
    }
    const userId = req.userId as string;
    const paramsHash = hash({ endpoint, body: req.body });

    const claimed = await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, params_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING key`,
      [key, userId, endpoint, paramsHash],
    );

    if (claimed.rowCount === 0) {
      const { rows } = await pool.query(
        `SELECT state, params_hash, response_status, response_body, updated_at
         FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE`,
        [userId, key],
      );
      const existing = rows[0];
      if (existing.params_hash !== paramsHash) {
        throw errors.conflict('idempotency_key_reused', 'This idempotency key was already used with different parameters');
      }
      if (existing.state === 'completed') {
        reply.code(existing.response_status);
        return existing.response_body;
      }
      if (existing.state === 'in_flight' && Date.now() - new Date(existing.updated_at).getTime() < STALE_MS) {
        throw errors.conflict('request_in_flight', 'The same request is still executing; retry with the same key shortly');
      }
      // failed or stale: take over and (re)run.
      await pool.query(
        `UPDATE idempotency_keys SET state = 'in_flight', updated_at = now() WHERE user_id = $1 AND key = $2`,
        [userId, key],
      );
    }

    try {
      const result = await handler(req);
      await pool.query(
        `UPDATE idempotency_keys SET state = 'completed', response_status = $3, response_body = $4, updated_at = now()
         WHERE user_id = $1 AND key = $2`,
        [userId, key, result.status, JSON.stringify(result.body)],
      );
      reply.code(result.status);
      return result.body;
    } catch (err) {
      if (err instanceof ApiError) {
        await pool.query(
          `UPDATE idempotency_keys SET state = 'completed', response_status = $3, response_body = $4, updated_at = now()
           WHERE user_id = $1 AND key = $2`,
          [userId, key, err.statusCode, JSON.stringify({ error: { code: err.code, message: err.message } })],
        );
      } else {
        await pool.query(
          `UPDATE idempotency_keys SET state = 'failed', updated_at = now() WHERE user_id = $1 AND key = $2`,
          [userId, key],
        );
      }
      throw err;
    }
  };
}
