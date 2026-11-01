import { createHash, randomBytes } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { pool } from './db.js';
import { errors } from './errors.js';

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
};

// Access tokens are short-lived and stateless (no DB read on the hot path).
// Revocation acts on refresh tokens: logout/reset revoke the refresh side and
// the access side expires within ACCESS_TOKEN_TTL.
export function signToken(userId: string, expiresIn: SignOptions['expiresIn'] = '15m'): string {
  return jwt.sign({ sub: userId, iss: 'teamform-api' }, secret(), { expiresIn });
}

export function verifyToken(token: string): string {
  try {
    const payload = jwt.verify(token, secret(), { issuer: 'teamform-api' }) as jwt.JwtPayload;
    if (!payload.sub) throw new Error('no sub');
    return payload.sub;
  } catch {
    throw errors.unauthorized();
  }
}

/** Fastify preHandler: attaches req.userId or rejects 401. */
export async function authenticate(req: any, _reply: any) {
  const header = req.headers['authorization'] as string | undefined;
  if (!header?.startsWith('Bearer ')) throw errors.unauthorized();
  req.userId = verifyToken(header.slice(7));
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Issue an opaque 30-day refresh token; only its SHA-256 hash is stored. */
export async function issueRefreshToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO auth_refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [userId, hashToken(token)],
  );
  return token;
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await pool.query(
    `UPDATE auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

/** Logout: revoke exactly the presented token. Unknown tokens are a no-op. */
export async function revokeRefreshToken(token: string): Promise<void> {
  await pool.query(
    `UPDATE auth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

/**
 * Rotate a refresh token: the presented token must exist, be unexpired and
 * unrevoked. Presenting an already-revoked token means a replay (the real
 * client rotated it away), so every session of that user is revoked.
 */
// Multi-tab safety: a rotated token stays presentable for a short grace
// window. Two tabs holding the same token will both refresh successfully;
// only AFTER the window is a presented rotated token treated as replay,
// revoking every session. Logout/reset revocations (no rotated_at) never
// get a grace window.
const graceMs = () => Number(process.env.REFRESH_GRACE_MS ?? 10_000);

export async function rotateRefreshToken(oldToken: string): Promise<{ userId: string; token: string }> {
  const { rows } = await pool.query(
    `SELECT id, user_id, revoked_at, rotated_at, expires_at FROM auth_refresh_tokens WHERE token_hash = $1`,
    [hashToken(oldToken)],
  );
  if (!rows.length) throw errors.unauthorized();
  const row = rows[0];
  if (row.revoked_at) {
    if (row.rotated_at && Date.now() - new Date(row.rotated_at).getTime() <= graceMs()) {
      // legitimate rotation race (second tab / retried response)
      return { userId: row.user_id, token: await issueRefreshToken(row.user_id) };
    }
    await revokeAllRefreshTokens(row.user_id);
    throw errors.unauthorized();
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) throw errors.unauthorized();
  await pool.query(`UPDATE auth_refresh_tokens SET revoked_at = now(), rotated_at = now() WHERE id = $1`, [row.id]);
  return { userId: row.user_id, token: await issueRefreshToken(row.user_id) };
}

/** Single-use action token (reset: 30 min, verify: 7 days); hash stored. */
export async function issueActionToken(userId: string, kind: 'reset' | 'verify'): Promise<string> {
  const token = randomBytes(24).toString('hex');
  const ttl = kind === 'reset' ? '30 minutes' : '7 days';
  await pool.query(
    `INSERT INTO auth_action_tokens (user_id, kind, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + $4::interval)`,
    [userId, kind, hashToken(token), ttl],
  );
  return token;
}

/** Atomically consume an action token; returns the user id or null. */
export async function consumeActionToken(token: string, kind: 'reset' | 'verify'): Promise<string | null> {
  const { rows } = await pool.query(
    `UPDATE auth_action_tokens SET used_at = now()
     WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token), kind],
  );
  return rows[0]?.user_id ?? null;
}
