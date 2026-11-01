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
// sid binds the access token to the refresh-token row (session) it was
// issued with, so an open SSE stream can re-check its session each poll:
// logout, password reset or replay lockout then stop the stream within one
// interval instead of up to the access TTL.
export function signToken(userId: string, sid?: string, expiresIn: SignOptions['expiresIn'] = '15m'): string {
  return jwt.sign({ sub: userId, iss: 'teamform-api', ...(sid ? { sid } : {}) }, secret(), { expiresIn });
}

export function verifyToken(token: string): { userId: string; sid?: string } {
  try {
    const payload = jwt.verify(token, secret(), { issuer: 'teamform-api' }) as jwt.JwtPayload;
    if (!payload.sub) throw new Error('no sub');
    return { userId: payload.sub, sid: typeof payload.sid === 'string' ? payload.sid : undefined };
  } catch {
    throw errors.unauthorized();
  }
}

/** Fastify preHandler: attaches req.userId or rejects 401. */
export async function authenticate(req: any, _reply: any) {
  const header = req.headers['authorization'] as string | undefined;
  if (!header?.startsWith('Bearer ')) throw errors.unauthorized();
  const v = verifyToken(header.slice(7));
  req.userId = v.userId;
  req.sessionId = v.sid;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** Issue an opaque 30-day refresh token; only its SHA-256 hash is stored. */
/** Start or extend a session family; only the token's SHA-256 hash is stored. */
export async function issueRefreshToken(userId: string, familyId?: string): Promise<{ token: string; id: string; familyId: string }> {
  const token = randomBytes(32).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO auth_refresh_tokens (user_id, token_hash, expires_at, family_id)
     VALUES ($1, $2, now() + interval '30 days', COALESCE($3::uuid, gen_random_uuid())) RETURNING id, family_id`,
    [userId, hashToken(token), familyId ?? null],
  );
  return { token, id: rows[0].id, familyId: rows[0].family_id };
}

/** True while the session family (sid in access tokens) has a live token. */
export async function isSessionValid(sid: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM auth_refresh_tokens
     WHERE COALESCE(family_id, id) = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [sid],
  );
  return rows.length > 0;
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await pool.query(
    `UPDATE auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

/** Logout: revoke the presented token's ENTIRE session family - grace-minted
 *  sibling tokens must not survive a logout. Unknown tokens are a no-op. */
export async function revokeRefreshToken(token: string): Promise<void> {
  await pool.query(
    `UPDATE auth_refresh_tokens SET revoked_at = now()
     WHERE COALESCE(family_id, id) = (
       SELECT COALESCE(family_id, id) FROM auth_refresh_tokens WHERE token_hash = $1
     ) AND revoked_at IS NULL`,
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

// Session-family rotation (the vetted pattern): one family per login. The
// sid in access tokens is the FAMILY id, so silent refresh does not disturb
// open SSE streams, and every token a client can hold - including anything
// minted through the grace window - belongs to one family that logout,
// password reset or replay detection revokes atomically.
//
// Grace window: a rotated token presented within REFRESH_GRACE_MS performs
// another rotation INSIDE the same family. Racing tabs therefore converge on
// individual current tokens of ONE session instead of branching independent
// sessions. The grace window never crosses family boundaries and can never
// create or extend a second session.
export async function rotateRefreshToken(oldToken: string): Promise<{ userId: string; token: string; id: string; familyId: string }> {
  const { rows } = await pool.query(
    `SELECT id, user_id, revoked_at, rotated_at, expires_at, COALESCE(family_id, id) AS family_id
     FROM auth_refresh_tokens WHERE token_hash = $1`,
    [hashToken(oldToken)],
  );
  if (!rows.length) throw errors.unauthorized();
  const row = rows[0];
  if (row.revoked_at) {
    if (row.rotated_at && Date.now() - new Date(row.rotated_at).getTime() <= graceMs()) {
      // legitimate rotation race: rotate again, same family
      const next = await issueRefreshToken(row.user_id, row.family_id);
      return { userId: row.user_id, token: next.token, id: next.id, familyId: row.family_id };
    }
    // replay after the window: kill the whole family, not just this token
    await pool.query(
      `UPDATE auth_refresh_tokens SET revoked_at = now()
       WHERE COALESCE(family_id, id) = $1 AND revoked_at IS NULL`,
      [row.family_id],
    );
    throw errors.unauthorized();
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) throw errors.unauthorized();
  await pool.query(`UPDATE auth_refresh_tokens SET revoked_at = now(), rotated_at = now() WHERE id = $1`, [row.id]);
  const next = await issueRefreshToken(row.user_id, row.family_id);
  return { userId: row.user_id, token: next.token, id: next.id, familyId: row.family_id };
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
