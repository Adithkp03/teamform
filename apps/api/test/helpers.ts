process.env.FIREBASE_TEST_MODE = 'true';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';
import { signToken } from '../src/auth.js';
import { buildApp } from '../src/app.js';

const here = dirname(fileURLToPath(import.meta.url));
export const app = buildApp();

export function migrate() {
  execSync('node db/migrate.mjs', {
    cwd: join(here, '../../..'),
    env: process.env as any,
    stdio: 'inherit',
  });
}

export async function resetDb(opts: { min?: number; max?: number } = {}) {
  await pool.query(
    `TRUNCATE join_requests, team_invitations, team_members, teams, profiles, idempotency_keys, audit_log, rate_limits, hackathons, domain_events, auth_refresh_tokens, auth_action_tokens, suggestion_impressions, suggestion_feedback RESTART IDENTITY CASCADE`,
  );
  await pool.query(
    `INSERT INTO hackathons (slug, name, team_size_min, team_size_max) VALUES ('ps1', 'Test Hackathon', $1, $2)`,
    [opts.min ?? 2, opts.max ?? 4],
  );
}

export async function makeUser(name = 'User', skills: string[] = [], utcOffset = 330) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO profiles (id, display_name, skills, utc_offset_minutes) VALUES ($1, $2, $3, $4)`,
    [id, name, skills, utcOffset],
  );
  return { id, token: signToken(id) };
}

/** User with a VERIFIED email address (organizer allowlist requires verification). */
export async function makeEmailUser(name: string, email: string, opts: { verified?: boolean } = {}) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO profiles (id, display_name, email, email_verified_at) VALUES ($1, $2, $3, ${opts.verified === false ? 'NULL' : 'now()'})`,
    [id, name, email.toLowerCase()],
  );
  return { id, token: signToken(id) };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
export const idemKey = () => crypto.randomUUID();

export async function createTeam(token: string, name = 'Team A', extra: object = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/teams',
    headers: { ...auth(token), 'idempotency-key': idemKey() },
    payload: { name, ...extra },
  });
  return res;
}

/** Unsigned offline Firebase token accepted only with FIREBASE_TEST_MODE=true (never production). */
export const testIdToken = (email: string, verified = true, uid?: string) =>
  Buffer.from(JSON.stringify({ uid: uid ?? `test-${email.toLowerCase()}`, email: email.toLowerCase(), email_verified: verified })).toString('base64url');

/** Offline Firebase refresh token mirroring testIdToken's uid (`fb-refresh-<email>` -> `test-<email>`). */
export const testRefreshToken = (email: string) => `fb-refresh-${email.toLowerCase()}`;

/** Exchange an offline Firebase token for an app session, as the web client does. */
export function firebaseSignup(name = 'User', email?: string, verified = true) {
  const addr = (email ?? `${crypto.randomUUID()}@test.dev`).toLowerCase();
  return app.inject({
    method: 'POST', url: '/api/auth/firebase',
    payload: { id_token: testIdToken(addr, verified), firebase_refresh_token: testRefreshToken(addr), display_name: name },
  });
}
