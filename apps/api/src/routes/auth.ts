import { mailConfigured } from '../mailer.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { rateLimit } from '../ratelimit.js';
import {
  authenticate, signToken, verifyToken, issueRefreshToken, rotateRefreshToken,
  revokeRefreshToken, revokeAllRefreshTokens, issueActionToken, consumeActionToken,
} from '../auth.js';
import {
  verifyFirebaseIdToken, redeemFirebaseRefreshToken, encryptRefreshToken, decryptRefreshToken,
} from '../firebase.js';
import { createHash } from 'node:crypto';
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// Legacy password-era sessions (no Firebase credential) may rotate only
// until this cutoff; afterwards they must go through the claim flow.
// Default: 7 days after the Firebase reland. Documented in the walkthrough.
const LEGACY_SESSION_SUNSET = new Date(process.env.LEGACY_SESSION_SUNSET ?? '2026-11-10T00:00:00Z');
const legacySessionsExpired = () => Date.now() >= LEGACY_SESSION_SUNSET.getTime();
import { parse } from '../util.js';
import { errors } from '../errors.js';
import { sendAuthMail, authMailUrl } from '../mailer.js';

const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  skills: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  timezone: z.string().trim().min(1).max(60).default('UTC'),
  utc_offset_minutes: z.number().int().min(-840).max(840).default(0),
  looking_for_team: z.boolean().default(true),
});

const credSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});

export default async function authRoutes(app: FastifyInstance) {
  // Local/dev only: mint a JWT for a synthetic user without Supabase.
  if (process.env.ALLOW_DEV_LOGIN === 'true') {
    app.post('/api/auth/dev-login', async (req) => {
      const body = parse(z.object({ user_id: z.string().uuid().optional(), display_name: z.string().min(1).max(80).default('Dev User') }), req.body);
      const id = body.user_id ?? crypto.randomUUID();
      await pool.query(
        `INSERT INTO profiles (id, display_name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, last_active_at = now()`,
        [id, body.display_name],
      );
      return { token: signToken(id), user_id: id };
    });
  }

  app.post('/api/auth/signup', async (req) => {
    const body = parse(credSchema.extend({ display_name: z.string().trim().min(1).max(80) }), req.body);
    await rateLimit(`auth:${req.ip}`, 10, 60);
    const password_hash = await bcrypt.hash(body.password, 10);
    const id = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO profiles (id, display_name, email, password_hash) VALUES ($1, $2, $3, $4)`,
        [id, body.display_name, body.email.toLowerCase(), password_hash],
      );
    } catch (e: any) {
      if (e?.code === '23505') throw errors.conflict('email_taken', 'An account with this email already exists');
      throw e;
    }
    const verifyToken = await issueActionToken(id, 'verify');
    await sendAuthMail(body.email.toLowerCase(), 'verify', authMailUrl('verify', verifyToken));
    const session = await issueRefreshToken(id);
    return { token: signToken(id, session.familyId), refresh_token: session.token, user_id: id };
  });

  app.post('/api/auth/login', async (req) => {
    const body = parse(credSchema, req.body);
    await rateLimit(`auth:${req.ip}`, 10, 60);
    const { rows } = await pool.query(
      `SELECT id, password_hash FROM profiles WHERE lower(email) = lower($1) AND password_hash IS NOT NULL`,
      [body.email],
    );
    // Same response for unknown email and wrong password: no account enumeration.
    if (!rows.length || !(await bcrypt.compare(body.password, rows[0].password_hash))) {
      throw errors.unauthorized();
    }
    const session = await issueRefreshToken(rows[0].id);
    return { token: signToken(rows[0].id, session.familyId), refresh_token: session.token, user_id: rows[0].id };
  });

  // Firebase sign-in: the client authenticates with Firebase (email +
  // password; verification and reset emails are sent by Firebase) and
  // exchanges its Firebase ID token AND refresh token here for our
  // short-lived access JWT plus a refresh-token session family. The refresh
  // token is required: it is what makes later Firebase-side revocation
  // (password reset/change/disable) enforceable at app-token rotation.
  // Verification status comes from the verified token server-side, never
  // from client-reported state.
  app.post('/api/auth/firebase', async (req) => {
    const body = parse(z.object({
      id_token: z.string().min(1).max(8192),
      firebase_refresh_token: z.string().min(1).max(4096),
      display_name: z.string().trim().min(1).max(80).optional(),
    }), req.body);
    await rateLimit(`auth:${req.ip}`, 10, 60);
    const identity = await verifyFirebaseIdToken(body.id_token);
    if (!identity.email) throw errors.unauthorized();
    if (identity.email_verified !== true) {
      throw errors.forbidden('email_unverified: verify your email address before signing in');
    }
    // Bind before storing: redeem the presented refresh token and require
    // the redeemed identity's uid to match the ID token's sub. A refresh
    // token that is merely valid for some OTHER Firebase account is
    // rejected, so the stored bearer credential provably belongs to this
    // sign-in. Fail closed on any error.
    const bound = await redeemFirebaseRefreshToken(body.firebase_refresh_token);
    if (!bound.ok) {
      if (bound.reason === 'unavailable') throw errors.unavailable('firebase_unavailable', 'Sign-in verification is temporarily unavailable');
      throw errors.unauthorized();
    }
    if (bound.identity.uid !== identity.uid) throw errors.unauthorized();
    const email = identity.email.toLowerCase();
    const displayName = body.display_name ?? email.split('@')[0].slice(0, 80) ?? 'User';

    let userId: string;
    const { rows: byUid } = await pool.query('SELECT id FROM profiles WHERE firebase_uid = $1', [identity.uid]);
    if (byUid.length) {
      userId = byUid[0].id;
      await pool.query('UPDATE profiles SET last_active_at = now() WHERE id = $1', [userId]);
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // A profile already linked to a DIFFERENT Firebase uid for the same
        // email is an identity mismatch: refuse, never re-link silently.
        const { rows: linked } = await client.query(
          `SELECT id FROM profiles WHERE lower(email) = lower($1) AND firebase_uid IS NOT NULL AND firebase_uid <> $2 FOR UPDATE`,
          [email, identity.uid],
        );
        if (linked.length) {
          await client.query('ROLLBACK');
          throw errors.conflict('email_taken', 'This email is already linked to a different sign-in account');
        }
        // Collision policy for legacy password-era profiles: NEVER detach,
        // never auto-inherit. A legacy profile holding this email blocks
        // fresh sign-up and must be claimed through /api/auth/firebase/claim
        // (legacy password or an authenticated legacy session, plus this
        // verified Firebase identity). Email equality alone confers nothing.
        const { rows: legacy } = await client.query(
          `SELECT id FROM profiles WHERE lower(email) = lower($1) AND firebase_uid IS NULL AND password_hash IS NOT NULL FOR UPDATE`,
          [email],
        );
        if (legacy.length) {
          await client.query('ROLLBACK');
          throw errors.conflict('legacy_claim_required', 'An existing TeamForm account uses this email; sign in with your legacy password to migrate it');
        }
        userId = crypto.randomUUID();
        await client.query(
          `INSERT INTO profiles (id, display_name, email, firebase_uid, email_verified_at)
           VALUES ($1, $2, $3, $4, now())`,
          [userId, displayName, email, identity.uid],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }

    const session = await issueRefreshToken(userId);
    // Store the (encrypted) Firebase refresh token on the session family's
    // first row so later rotations can prove the Firebase credential is
    // still valid. Server-only: never logged, never returned to clients,
    // nulled when the family is revoked.
    await pool.query(
      `UPDATE auth_refresh_tokens SET firebase_refresh_token = $1 WHERE id = $2`,
      [encryptRefreshToken(bound.refreshToken), session.id],
    );
    return { token: signToken(userId, session.familyId), refresh_token: session.token, user_id: userId };
  });

  // Claim a legacy password-era profile onto a verified Firebase identity.
  // Per the ownership gate, email equality and intent alone confer NOTHING:
  // the caller must prove legacy ownership with the profile's legacy
  // password OR an existing authenticated legacy session bound to that same
  // profile, AND present a verified Firebase identity whose UID-bound
  // refresh token matches. On success the profile keeps its id, teams and
  // roles, its password is cleared, all prior sessions are revoked, and a
  // fresh Firebase-backed session family is issued.
  app.post('/api/auth/firebase/claim', async (req) => {
    const body = parse(z.object({
      id_token: z.string().min(1).max(8192),
      firebase_refresh_token: z.string().min(1).max(4096),
      legacy_email: z.string().email().max(320).optional(),
      legacy_password: z.string().min(1).max(200).optional(),
    }), req.body);
    await rateLimit(`auth:${req.ip}`, 10, 60);
    const identity = await verifyFirebaseIdToken(body.id_token);
    if (!identity.email) throw errors.unauthorized();
    if (identity.email_verified !== true) {
      throw errors.forbidden('email_unverified: verify your email address before signing in');
    }
    const bound = await redeemFirebaseRefreshToken(body.firebase_refresh_token);
    if (!bound.ok) {
      if (bound.reason === 'unavailable') throw errors.unavailable('firebase_unavailable', 'Sign-in verification is temporarily unavailable');
      throw errors.unauthorized();
    }
    if (bound.identity.uid !== identity.uid) throw errors.unauthorized();

    // Legacy-ownership proof: password, or an authenticated legacy session.
    let viaSessionUserId: string | null = null;
    if (!body.legacy_password) {
      const header = req.headers.authorization ?? '';
      const m = /^Bearer (.+)$/.exec(header);
      if (!m) throw errors.unauthorized();
      try {
        viaSessionUserId = verifyToken(m[1]).userId;
      } catch {
        throw errors.unauthorized();
      }
    }

    const client = await pool.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      let rows;
      if (body.legacy_password) {
        if (!body.legacy_email) throw errors.badRequest('legacy_email is required with legacy_password');
        rows = (await client.query(
          `SELECT id, password_hash FROM profiles
           WHERE lower(email) = lower($1) AND firebase_uid IS NULL AND password_hash IS NOT NULL FOR UPDATE`,
          [body.legacy_email],
        )).rows;
        // Same response for unknown email and wrong password: no enumeration.
        if (!rows.length || !(await bcrypt.compare(body.legacy_password, rows[0].password_hash))) {
          await client.query('ROLLBACK');
          throw errors.unauthorized();
        }
      } else {
        rows = (await client.query(
          `SELECT id, password_hash FROM profiles
           WHERE id = $1 AND firebase_uid IS NULL AND password_hash IS NOT NULL FOR UPDATE`,
          [viaSessionUserId],
        )).rows;
        if (!rows.length) {
          await client.query('ROLLBACK');
          throw errors.unauthorized();
        }
      }
      const legacy = rows[0];

      // The Firebase uid must not already be linked to a DIFFERENT profile.
      const { rows: linked } = await client.query(
        `SELECT id FROM profiles WHERE firebase_uid = $1 AND id <> $2 FOR UPDATE`,
        [identity.uid, legacy.id],
      );
      if (linked.length) {
        await client.query('ROLLBACK');
        throw errors.conflict('firebase_uid_taken', 'This sign-in account is already linked to a different profile');
      }

      await client.query(
        `UPDATE profiles SET firebase_uid = $1, password_hash = NULL,
           email = lower($2), email_verified_at = COALESCE(email_verified_at, now()), last_active_at = now()
         WHERE id = $3`,
        [identity.uid, identity.email, legacy.id],
      );
      await client.query(
        `INSERT INTO audit_log (actor_id, action, metadata) VALUES ($1, 'legacy_profile_claimed', $2)`,
        [legacy.id, JSON.stringify({ via: body.legacy_password ? 'password' : 'session', firebase_uid: identity.uid })],
      );
      await client.query('COMMIT');
      userId = legacy.id;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // All pre-claim sessions die; the account continues Firebase-backed only.
    await revokeAllRefreshTokens(userId);
    const session = await issueRefreshToken(userId);
    await pool.query(
      `UPDATE auth_refresh_tokens SET firebase_refresh_token = $1 WHERE id = $2`,
      [encryptRefreshToken(bound.refreshToken), session.id],
    );
    return { token: signToken(userId, session.familyId), refresh_token: session.token, user_id: userId };
  });

  // Rotation issues a new access token + refresh token and revokes the old
  // refresh token. Presenting an already-rotated token revokes ALL of the
  // user's sessions (replay detection).
  app.post('/api/auth/refresh', async (req) => {
    const body = parse(z.object({ refresh_token: z.string().min(1).max(128) }), req.body);
    await rateLimit(`auth:${req.ip}`, 30, 60);
    // Firebase-side revocation enforcement, checked BEFORE rotating so a
    // failure leaves the presented token (and family) untouched and the
    // client can retry. Every Firebase-exchanged session family carries the
    // account's (encrypted) Firebase refresh token; redeeming it proves the
    // underlying Firebase credential is still valid.
    //   - 'invalid' (password reset/change/disable): revoke the WHOLE family
    //     and 401, so a reset signs out stolen sessions, not just future
    //     logins.
    //   - 'unavailable' (Google outage/5xx): 503 and NO state change - no
    //     rotation, no revocation, the same refresh token stays valid so the
    //     client's next retry works. We never extend a session whose backing
    //     credential we cannot verify.
    // Access tokens live out their TTL regardless (15 minutes - see
    // signToken). Legacy password-era families carry no Firebase credential;
    // they rotate unchecked until LEGACY_SESSION_SUNSET, after which they
    // are refused (the claim flow converts them beforehand).
    const presented = await pool.query(
      `SELECT user_id, COALESCE(family_id, id) AS fam FROM auth_refresh_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(body.refresh_token)],
    );
    if (presented.rows.length) {
      const famId = presented.rows[0].fam;
      const { rows: fam } = await pool.query(
        `SELECT id, firebase_refresh_token FROM auth_refresh_tokens
         WHERE COALESCE(family_id, id) = $1 AND firebase_refresh_token IS NOT NULL
         ORDER BY created_at ASC LIMIT 1`,
        [famId],
      );
      if (fam.length) {
        const check = await redeemFirebaseRefreshToken(decryptRefreshToken(fam[0].firebase_refresh_token));
        if (!check.ok) {
          if (check.reason === 'unavailable') {
            throw errors.unavailable('firebase_unavailable', 'Sign-in verification is temporarily unavailable');
          }
          await pool.query(
            `UPDATE auth_refresh_tokens SET revoked_at = now(), firebase_refresh_token = NULL
             WHERE COALESCE(family_id, id) = $1 AND revoked_at IS NULL`,
            [famId],
          );
          throw errors.unauthorized();
        }
        // Persist the latest Firebase refresh token (Google may return a new
        // one) on the family row.
        await pool.query(
          `UPDATE auth_refresh_tokens SET firebase_refresh_token = $1 WHERE id = $2`,
          [encryptRefreshToken(check.refreshToken), fam[0].id],
        );
      } else if (legacySessionsExpired()) {
        throw errors.unauthorized();
      }
    }
    const { userId, token, familyId } = await rotateRefreshToken(body.refresh_token);
    return { token: signToken(userId, familyId), refresh_token: token, user_id: userId };
  });

  // Logout revokes the refresh session. The current access token remains
  // valid until its short expiry by design (documented trade-off).
  app.post('/api/auth/logout', async (req) => {
    const body = parse(z.object({ refresh_token: z.string().min(1).max(128) }), req.body);
    await rateLimit(`auth:${req.ip}`, 30, 60);
    await revokeRefreshToken(body.refresh_token);
    return { ok: true };
  });

  // Always the same response whether or not the email exists: no enumeration.
  app.post('/api/auth/forgot-password', async (req) => {
    const body = parse(z.object({ email: z.string().trim().email().max(254) }), req.body);
    await rateLimit(`forgot:${req.ip}`, 5, 60);
    if (!mailConfigured) throw errors.unavailable('email_not_configured', 'Email delivery is not configured on this deployment');
    const { rows } = await pool.query(
      `SELECT id, email FROM profiles WHERE lower(email) = lower($1) AND password_hash IS NOT NULL`,
      [body.email],
    );
    if (rows.length) {
      const token = await issueActionToken(rows[0].id, 'reset');
      await sendAuthMail(rows[0].email, 'reset', authMailUrl('reset', token));
    }
    return { ok: true };
  });

  // Reset consumes the token atomically and revokes every refresh session.
  app.post('/api/auth/reset-password', async (req) => {
    const body = parse(z.object({ token: z.string().min(1).max(128), password: z.string().min(8).max(128) }), req.body);
    await rateLimit(`reset:${req.ip}`, 10, 60);
    const userId = await consumeActionToken(body.token, 'reset');
    if (!userId) throw errors.unauthorized();
    const password_hash = await bcrypt.hash(body.password, 10);
    await pool.query(`UPDATE profiles SET password_hash = $2 WHERE id = $1`, [userId, password_hash]);
    await revokeAllRefreshTokens(userId);
    return { ok: true };
  });

  app.post('/api/auth/verify-email', async (req) => {
    const body = parse(z.object({ token: z.string().min(1).max(128) }), req.body);
    await rateLimit(`verify:${req.ip}`, 10, 60);
    const userId = await consumeActionToken(body.token, 'verify');
    if (!userId) throw errors.unauthorized();
    await pool.query(`UPDATE profiles SET email_verified_at = now() WHERE id = $1`, [userId]);
    return { ok: true };
  });

  app.post('/api/auth/resend-verification', { preHandler: authenticate }, async (req: any) => {
    await rateLimit(`verify:${req.userId}`, 3, 60);
    if (!mailConfigured) throw errors.unavailable('email_not_configured', 'Email delivery is not configured on this deployment');
    const { rows } = await pool.query(`SELECT email, email_verified_at FROM profiles WHERE id = $1`, [req.userId]);
    if (!rows[0]?.email) throw errors.conflict('no_email', 'This account has no email address');
    if (rows[0].email_verified_at) return { ok: true, already_verified: true };
    const token = await issueActionToken(req.userId, 'verify');
    await sendAuthMail(rows[0].email, 'verify', authMailUrl('verify', token));
    return { ok: true };
  });

  app.get('/api/me', { preHandler: authenticate }, async (req: any) => {
    const { rows } = await pool.query(
      `SELECT id, display_name, skills, timezone, utc_offset_minutes, looking_for_team, email,
              created_at, last_active_at, (email_verified_at IS NOT NULL) AS email_verified
       FROM profiles WHERE id = $1`, [req.userId]);
    if (!rows.length) throw errors.notFound('Profile not found; create it with PUT /api/me');
    return { profile: rows[0] };
  });

  app.put('/api/me', { preHandler: authenticate }, async (req: any) => {
    const body = parse(profileSchema, req.body);
    await rateLimit(`profile:${req.userId}`, 20, 60);
    const { rows } = await pool.query(
      `INSERT INTO profiles (id, display_name, skills, timezone, utc_offset_minutes, looking_for_team, last_active_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, skills = EXCLUDED.skills,
         timezone = EXCLUDED.timezone, utc_offset_minutes = EXCLUDED.utc_offset_minutes,
         looking_for_team = EXCLUDED.looking_for_team, last_active_at = now()
       RETURNING *`,
      [req.userId, body.display_name, body.skills, body.timezone, body.utc_offset_minutes, body.looking_for_team],
    );
    return { profile: rows[0] };
  });
}
