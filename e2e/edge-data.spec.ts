import { test, expect, type Page } from '@playwright/test';
import { signup, uniqueEmail } from './helpers';

// 80-char unbroken strings and 20 max-length skills: the worst data the schema allows.
const LONG_NAME = 'Supercalifragilisticexpialidocious'.repeat(3).slice(0, 80);
const LONG_SKILLS = Array.from({ length: 20 }, (_, i) => `skillnumber${i}`.padEnd(40, 'x'));

async function seamUser(page: Page, name: string) {
  const email = uniqueEmail(name);
  const idToken = Buffer.from(JSON.stringify({ uid: `test-${email}`, email, email_verified: true })).toString('base64url');
  const res = await page.request.post('http://localhost:3100/api/auth/firebase', {
    data: { id_token: idToken, firebase_refresh_token: `fb-refresh-${email}`, display_name: name },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).token as string;
}

async function setProfile(page: Page, token: string, name: string, skills: string[]) {
  const res = await page.request.put('http://localhost:3100/api/me', {
    headers: { Authorization: `Bearer ${token}` },
    data: { display_name: name, skills, timezone: 'Asia/Kolkata', utc_offset_minutes: 330, looking_for_team: true },
  });
  expect(res.status()).toBe(200);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  await expect.poll(
    () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    { message: `horizontal overflow on ${label}` },
  ).toBe(true);
}

test('long names and max skills do not break narrow layouts', async ({ page }) => {
  // Team owner with a max-length team and max-length everything.
  const ownerToken = await seamUser(page, 'Edge Owner');
  await setProfile(page, ownerToken, LONG_NAME, LONG_SKILLS);
  const teamRes = await page.request.post('http://localhost:3100/api/teams', {
    headers: { Authorization: `Bearer ${ownerToken}`, 'idempotency-key': `edge-${Date.now()}` },
    data: { name: LONG_NAME, wanted_skills: LONG_SKILLS, looking_for_members: true },
  });
  expect(teamRes.status()).toBe(201);
  const team = (await teamRes.json()).team;

  // Suggestion candidate: long name, complementary long skills, not in a team.
  const candToken = await seamUser(page, 'Edge Candidate');
  await setProfile(page, candToken, LONG_NAME, LONG_SKILLS);

  await signup(page, 'Edge Viewer');
  const viewerToken = await page.evaluate(() => localStorage.getItem('tf_token')) as string;
  await setProfile(page, viewerToken, LONG_NAME, ['react']);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });

    await page.goto('/board');
    await expect(page.getByRole('link', { name: LONG_NAME }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, `board @${width}`);

    await page.goto(`/team/${team.id}`);
    await expect(page.getByRole('heading', { name: LONG_NAME })).toBeVisible();
    await expectNoHorizontalOverflow(page, `team @${width}`);

    await page.goto('/suggestions');
    await expect(page.getByText(LONG_NAME).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, `suggestions @${width}`);

    await page.goto('/profile');
    await expect(page.getByLabel('Display name')).toHaveValue(LONG_NAME);
    await expectNoHorizontalOverflow(page, `profile @${width}`);
  }
});
