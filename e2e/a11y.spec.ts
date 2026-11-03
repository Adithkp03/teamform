import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { signup } from './helpers';

// Automated accessibility scan of every page: no serious or critical violations.
test('no serious/critical axe violations on any page', async ({ page }) => {
  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad, `${label}: ${bad.map((v) => `${v.id} (${v.impact})`).join(', ')}`).toEqual([]);
  };

  await page.goto('/login');
  await scan('login');

  await signup(page, 'A11y User');
  await scan('profile');

  await page.goto('/board');
  await page.getByLabel('Team name').fill('A11y Team');
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page).toHaveURL(/\/team\//);
  await scan('team');

  await page.goto('/board');
  await scan('board');

  await page.goto('/suggestions');
  await page.waitForLoadState('networkidle');
  await scan('suggestions');
});

// Mobile accessibility-SEMANTICS pass at phone width: axe scans plus explicit
// ARIA naming/state assertions (accessible names, aria-pressed). This is NOT
// VoiceOver/TalkBack testing - it verifies the semantics a screen reader
// consumes, on the widths a phone screen reader user would have.
test('mobile 390px: accessibility semantics (not a screen-reader run)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad, `${label}: ${bad.map((v) => `${v.id} (${v.impact})`).join(', ')}`).toEqual([]);
  };

  await signup(page, 'Mobile SR User');
  await page.goto('/board');
  // The board holds an open SSE stream, so networkidle never settles here;
  // wait on the primary control instead (the earlier CI failure was exactly
  // this - retained as evidence of why).
  await expect(page.getByRole('button', { name: 'Create team' })).toBeVisible();

  // Primary actions remain present and named at phone width.
  await expect(page.getByLabel('Team name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create team' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join with code' })).toBeVisible();
  await scan('board@390');

  await page.goto('/suggestions');
  await page.waitForLoadState('networkidle');
  await scan('suggestions@390');

  // Feedback votes, when suggestions exist, are a named group with pressed state.
  const group = page.getByRole('group', { name: /Was the suggestion/ });
  if (await group.count()) {
    await expect(group.first().getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'false');
    await group.first().getByRole('button', { name: 'Yes' }).click();
    await expect(group.first().getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
  }
});
