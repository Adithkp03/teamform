import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signup } from './helpers';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/teamform_e2e';

// The board tab badge shows the loaded page length, not a grand total: the API
// paginates (keyset cursors) and returns no total. When a next page exists the
// badge must say so ("24+") instead of implying 24 is everything. Regression
// coverage for the misleading "(24)" observed in production.
test('board badge marks a truncated first page with + and an exact count without one', async ({ page }) => {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const { rows: [h] } = await client.query(`SELECT id FROM hackathons LIMIT 1`);
  // 26 teams > 24-card first page. One leader per team (one-team-per-person invariant).
  const { rows: leaders } = await client.query(
    `INSERT INTO profiles (display_name, is_seed, looking_for_team)
     SELECT 'Badge Seed Leader ' || g, true, false FROM generate_series(1, 26) g RETURNING id`);
  for (let i = 0; i < 26; i++) {
    const { rows: [t] } = await client.query(
      `INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id`,
      [h.id, `Badge Seed Team ${i}`, leaders[i].id, `BDG${Date.now()}${i}`.slice(0, 24)]);
    await client.query(
      `INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'leader')`,
      [t.id, h.id, leaders[i].id]);
  }
  await client.end();

  await signup(page, 'Badge Viewer');
  await page.goto('/board');
  // 26 seeded teams, page size 24: truncated page is marked.
  await expect(page.getByRole('tab', { name: /Teams looking/ })).toHaveText(/^Teams looking \(24\+\)$/);
  // People side is below the page size here, so its count is exact - no '+'.
  await expect(page.getByRole('tab', { name: /People looking/ })).toHaveText(/^People looking \(\d+\)$/);
});
