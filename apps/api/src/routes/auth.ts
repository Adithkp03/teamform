import { mailConfigured } from '../mailer.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { rateLimit } from '../ratelimit.js';
import {
  authenticate, signToken, issueRefreshToken, rotateRefreshToken,
  revokeRefreshToken, revokeAllRefreshTokens, issueActionToken, consumeActionToken,
} from '../auth.js';
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
    return { token: signToken(id, session.id), refresh_token: session.token, user_id: id };
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
    return { token: signToken(rows[0].id, session.id), refresh_token: session.token, user_id: rows[0].id };
  });

  // Rotation issues a new access token + refresh token and revokes the old
  // refresh token. Presenting an already-rotated token revokes ALL of the
  // user's sessions (replay detection).
  app.post('/api/auth/refresh', async (req) => {
    const body = parse(z.object({ refresh_token: z.string().min(1).max(128) }), req.body);
    await rateLimit(`auth:${req.ip}`, 30, 60);
    const { userId, token, id } = await rotateRefreshToken(body.refresh_token);
    return { token: signToken(userId, id), refresh_token: token, user_id: userId };
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
