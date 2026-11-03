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

/** Revoke every family of the user (password reset). Family-locked so a
 *  rotation racing the reset cannot mint a survivor afterwards. */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fams = await client.query(
      `SELECT DISTINCT COALESCE(family_id, id) AS fam FROM auth_refresh_tokens WHERE user_id = $1`,
      [userId],
    );
    for (const { fam } of fams.rows) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [fam]);
    }
    await client.query(
      `UPDATE auth_refresh_tokens SET revoked_at = now(), firebase_refresh_token = NULL WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Logout: revoke the presented token's ENTIRE session family - grace-minted
 *  sibling tokens must not survive a logout. The family advisory lock makes
 *  this atomic with rotation: a racing rotation either mints before the lock
 *  (and its successor is revoked here) or re-reads the revoked state after.
 *  Unknown tokens are a no-op. */
export async function revokeRefreshToken(token: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT COALESCE(family_id, id) AS fam FROM auth_refresh_tokens WHERE token_hash = $1`,
      [hashToken(token)],
    );
    if (rows.length) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [rows[0].fam]);
      await client.query(
        `UPDATE auth_refresh_tokens SET revoked_at = now(), firebase_refresh_token = NULL WHERE COALESCE(family_id, id) = $1 AND revoked_at IS NULL`,
        [rows[0].fam],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, user_id, revoked_at, rotated_at, expires_at, COALESCE(family_id, id) AS family_id
       FROM auth_refresh_tokens WHERE token_hash = $1`,
      [hashToken(oldToken)],
    );
    if (!rows.length) { await client.query('ROLLBACK'); throw errors.unauthorized(); }
    const familyId = rows[0].family_id;
    // Serialize with logout/reset on this family, then re-read the presented
    // token under the lock so a revocation that landed in between is seen.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [familyId]);
    const { rows: cur } = await client.query(
      `SELECT id, user_id, revoked_at, rotated_at, expires_at FROM auth_refresh_tokens WHERE id = $1`,
      [rows[0].id],
    );
    const row = cur[0];
    const mintInFamily = async () => {
      const token = randomBytes(32).toString('hex');
      // Absolute family lifetime: the successor inherits the presented
      // token's expires_at - rotation never extends the family's authority.
      const ins = await client.query(
        `INSERT INTO auth_refresh_tokens (user_id, token_hash, expires_at, family_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [row.user_id, hashToken(token), row.expires_at, familyId],
      );
      return { token, id: ins.rows[0].id };
    };
    if (row.revoked_at) {
      if (row.rotated_at && Date.now() - new Date(row.rotated_at).getTime() <= graceMs()) {
        // Legitimate rotation race: rotate again, same family - but only while
        // the family is still ALIVE. Logout/reset/replay-kill revoke every
        // family member; a grace-window replay of a rotated token must not
        // resurrect a dead family (that would let a session survive logout).
        const { rows: live } = await client.query(
          `SELECT 1 FROM auth_refresh_tokens WHERE COALESCE(family_id, id) = $1 AND revoked_at IS NULL LIMIT 1`,
          [familyId],
        );
        if (live.length) {
          // The window is anchored at THIS token's rotated_at - fixed, never rolling.
          const next = await mintInFamily();
          await client.query('COMMIT');
          return { userId: row.user_id, token: next.token, id: next.id, familyId };
        }
      }
      // replay after the window or into a dead family: kill the whole family (RFC 9700 reuse detection)
      await client.query(
        `UPDATE auth_refresh_tokens SET revoked_at = now(), firebase_refresh_token = NULL WHERE COALESCE(family_id, id) = $1 AND revoked_at IS NULL`,
        [familyId],
      );
      await client.query('COMMIT');
      throw errors.unauthorized();
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) { await client.query('ROLLBACK'); throw errors.unauthorized(); }
    await client.query(`UPDATE auth_refresh_tokens SET revoked_at = now(), rotated_at = now() WHERE id = $1`, [row.id]);
    const next = await mintInFamily();
    await client.query('COMMIT');
    return { userId: row.user_id, token: next.token, id: next.id, familyId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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

// ---------------------------------------------------------------------------
// Organizer authorization.
// An explicit allowlist of profile emails in ORGANIZER_EMAILS (comma-
// separated). Empty or unset = NO organizers at all (fail closed): the
// operations endpoints simply 403. Organizer powers are operations tooling:
// audit search/export, stuck-request resolution, event settings, matching
// metrics. Nothing here can impersonate a user or bypass team invariants.
// ---------------------------------------------------------------------------
const organizerEmails = () =>
  new Set(
    (process.env.ORGANIZER_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

/** Fastify preHandler: authenticate + require the caller's profile email in ORGANIZER_EMAILS.
 *
 * The email must be VERIFIED (email_verified_at set): an allowlisted address
 * on an unverified profile proves nothing - legacy signup accepts any email
 * without proof of ownership, so without this check anyone could register an
 * organizer's address with their own password and take organizer rights.
 * Firebase-exchanged profiles are verified by the exchange gate; legacy
 * profiles become eligible only after consuming a verification link. */
export async function requireOrganizer(req: any, reply: any) {
  await authenticate(req, reply);
  const allowed = organizerEmails();
  if (!allowed.size) throw errors.forbidden('No organizers are configured on this deployment');
  const { rows } = await pool.query(
    `SELECT lower(email) AS email FROM profiles WHERE id = $1 AND email_verified_at IS NOT NULL`,
    [req.userId],
  );
  const email = rows[0]?.email as string | undefined;
  if (!email || !allowed.has(email)) throw errors.forbidden('Organizer access required');
}
