import { execSync } from 'node:child_process';
import pg from 'pg';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/teamform_e2e';

export default async function globalSetup() {
  execSync('node db/migrate.mjs', { env: { ...process.env, DATABASE_URL: DB }, stdio: 'inherit' });
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  await client.query(
    `TRUNCATE join_requests, team_members, teams, profiles, idempotency_keys, audit_log,
              rate_limits, hackathons, domain_events, auth_refresh_tokens, auth_action_tokens
     RESTART IDENTITY CASCADE`,
  );
  await client.query(
    `INSERT INTO hackathons (slug, name, team_size_min, team_size_max) VALUES ('ps1', 'E2E Hackathon', 2, 4)`,
  );
  await client.end();
}
