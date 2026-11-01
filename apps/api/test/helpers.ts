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
    `TRUNCATE join_requests, team_members, teams, profiles, idempotency_keys, audit_log, rate_limits, hackathons, domain_events RESTART IDENTITY CASCADE`,
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
