import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { rateLimit } from '../ratelimit.js';
import { authenticate, signToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from '../auth.js';
import { verifyFirebaseIdToken, firebaseTokensValidAfter } from '../firebase.js';
import { parse } from '../util.js';
import { errors } from '../errors.js';

const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  skills: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  timezone: z.string().trim().min(1).max(60).default('UTC'),
  utc_offset_minutes: z.number().int().min(-840).max(840).default(0),
  looking_for_team: z.boolean().default(true),
});

export default async function authRoutes(app: FastifyInstance) {
  // Local/dev only: mint a JWT for a synthetic user without any identity
  // provider. Never enabled on Vercel (ALLOW_DEV_LOGIN is not set there).
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

  // The one sign-in path: the client authenticates with Firebase (email +
  // password, verification and reset emails are sent by Firebase) and
  // exchanges the Firebase ID token here for our short-lived access JWT plus
  // a refresh-token session family. Verification status is checked from the
  // verified token server-side, never from client-reported state.
  app.post('/api/auth/firebase', async (req) => {
    const body = parse(z.object({
      id_token: z.string().min(1).max(8192),
      display_name: z.string().trim().min(1).max(80).optional(),
    }), req.body);
    await rateLimit(`auth:${req.ip}`, 10, 60);
    const identity = await verifyFirebaseIdToken(body.id_token);
    if (!identity.email) throw errors.unauthorized();
    if (identity.email_verified !== true) {
      throw errors.forbidden('email_unverified: verify your email address before signing in');
    }
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
        // Collision policy for legacy password-era profiles: their email was
        // never verified, so a verified Firebase sign-in wins the EMAIL
        // identifier but inherits NOTHING. The legacy profile keeps its id,
        // teams and history as unreachable data with the email detached and
        // audited; the new account starts with a fresh empty profile.
        const { rows: legacy } = await client.query(
          `SELECT id FROM profiles WHERE lower(email) = lower($1) AND firebase_uid IS NULL FOR UPDATE`,
          [email],
        );
        for (const l of legacy) {
          await client.query('UPDATE profiles SET email = NULL, email_verified_at = NULL WHERE id = $1', [l.id]);
          await client.query(
            `INSERT INTO audit_log (actor_id, action, metadata) VALUES ($1, 'legacy_email_detached', $2)`,
            [l.id, JSON.stringify({ new_firebase_uid: identity.uid })],
          );
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
    return { token: signToken(userId, session.familyId), refresh_token: session.token, user_id: userId };
  });

  // Rotation issues a new access token + refresh token and revokes the old
  // refresh token. Presenting an already-rotated token revokes ALL of the
  // user's sessions (replay detection).
  app.post('/api/auth/refresh', async (req) => {
    const body = parse(z.object({ refresh_token: z.string().min(1).max(128) }), req.body);
    await rateLimit(`auth:${req.ip}`, 30, 60);
    const { userId, token, familyId } = await rotateRefreshToken(body.refresh_token);

    // Firebase-side revocation: a password reset/change (or explicit
    // revocation) on the linked Firebase account invalidates app sessions
    // minted BEFORE that moment at their next rotation, so a reset actually
    // signs out stolen sessions instead of only future logins. The check is
    // one Admin API call per rotation (15-minute cadence per client), not on
    // the request hot path.
    const { rows: fam } = await pool.query(
      `SELECT p.firebase_uid, MIN(t.created_at) AS family_started
       FROM auth_refresh_tokens t JOIN profiles p ON p.id = t.user_id
       WHERE COALESCE(t.family_id, t.id) = $1 GROUP BY p.firebase_uid`,
      [familyId],
    );
    const firebaseUid = fam[0]?.firebase_uid;
    if (firebaseUid) {
      const validAfter = await firebaseTokensValidAfter(firebaseUid);
      const familyStarted = fam[0]?.family_started ? new Date(fam[0].family_started).getTime() / 1000 : null;
      if (validAfter !== null && familyStarted !== null && validAfter > familyStarted + 1) {
        await pool.query(
          `UPDATE auth_refresh_tokens SET revoked_at = now() WHERE COALESCE(family_id, id) = $1 AND revoked_at IS NULL`,
          [familyId],
        );
        throw errors.unauthorized();
      }
    }
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
