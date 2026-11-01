import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { rateLimit } from '../ratelimit.js';
import { authenticate, signToken } from '../auth.js';
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

  const credSchema = z.object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(128),
  });

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
    return { token: signToken(id), user_id: id };
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
    return { token: signToken(rows[0].id), user_id: rows[0].id };
  });

  app.get('/api/me', { preHandler: authenticate }, async (req: any) => {
    const { rows } = await pool.query(
      `SELECT id, display_name, skills, timezone, utc_offset_minutes, looking_for_team, email, created_at, last_active_at
       FROM profiles WHERE id = $1`, [req.userId]);
    if (!rows.length) throw errors.notFound('Profile not found; create it with PUT /api/me');
    return { profile: rows[0] };
  });

  app.put('/api/me', { preHandler: authenticate }, async (req: any) => {
    const body = parse(profileSchema, req.body);
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
