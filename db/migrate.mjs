// Minimal migration runner: applies db/migrations/*.sql in filename order,
// records applied versions in _migrations. Idempotent.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/teamform';
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const files = readdirSync(join(here, 'migrations')).filter(f => f.endsWith('.sql')).sort();
for (const f of files) {
  if (f === '0002_realtime.sql' && process.env.RUN_REALTIME_MIGRATION !== 'true') continue;
  const { rows } = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [f]);
  if (rows.length) { console.log(`skip ${f}`); continue; }
  console.log(`apply ${f}`);
  await client.query('BEGIN');
  try {
    await client.query(readFileSync(join(here, 'migrations', f), 'utf8'));
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
await client.end();
console.log('migrations up to date');
