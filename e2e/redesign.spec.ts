import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signup } from './helpers';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/teamform_e2e';
test('light layout fits phone and desktop; search filters loaded cards', async ({ page }, testInfo) => {
  // Seed 25 teams so pagination exists even standalone (page size is 24):
  // below the spec clicks Load-more and asserts it disappears at the end.
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const stamp = Date.now().toString(36);
  const prefix = `Redesign Seed ${stamp}`;
  try {
  const { rows: [h] } = await client.query(`SELECT id FROM hackathons LIMIT 1`);
  const { rows: leaders } = await client.query(
    `INSERT INTO profiles (id, display_name, is_seed, looking_for_team)
     SELECT gen_random_uuid(), $1 || ' Leader ' || g, true, false FROM generate_series(1, 25) g RETURNING id`, [prefix]);
  await client.query(
    `INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at)
     SELECT $1, $2 || ' Team ' || lpad(u.ord::text, 2, '0'), u.id, ($3 || u.ord::text), now() + interval '7 days'
     FROM unnest($4::uuid[]) WITH ORDINALITY AS u(id, ord)`,
    [h.id, prefix, `RS${stamp}`.slice(0, 20), leaders.map((l: any) => l.id)]);
  await client.query(
    `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
     SELECT t.id, $1, t.leader_id, 'leader' FROM teams t WHERE t.name LIKE $2`,
    [h.id, `${prefix}%`]);
  await page.goto('/login');
  await page.screenshot({ path: testInfo.outputPath('teamform-light-login.png'), fullPage: true });
  await signup(page, 'Design Review');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL('**/board');
  await page.getByLabel('Team name').fill('Design Explorers');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await page.waitForURL('**/team/**');
  await page.screenshot({ path: testInfo.outputPath('teamform-light-team.png'), fullPage: true });
  await page.goto('/board');
  await expect(page.getByRole('link', { name: 'Design Explorers', exact: true })).toBeVisible();
  await page.getByLabel('Search the whole board').fill('Design Explorers');
  await expect(page.getByRole('link', { name: 'Design Explorers', exact: true })).toBeVisible();
  await page.getByLabel('Search the whole board').fill('no-match-this-name');
  await expect(page.getByRole('link', { name: 'Design Explorers', exact: true })).toHaveCount(0);
  await page.getByLabel('Search the whole board').fill('');
  await page.getByRole('button', { name: 'Load more teams' }).click();
  await expect(page.getByRole('link', { name: 'Design Explorers', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Load more teams' })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('teamform-light-board-desktop.png'), fullPage: false });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`teamform-light-board-${width}.png`), fullPage: false });
  }
  await page.goto('/profile');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('teamform-light-profile-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('teamform-light-login-mobile.png'), fullPage: true });
  } finally {
    await client.query(`DELETE FROM teams WHERE name LIKE $1`, [`${prefix}%`]);
    await client.query(`DELETE FROM profiles WHERE display_name LIKE $1`, [`${prefix}%`]);
    await client.end();
  }
});
