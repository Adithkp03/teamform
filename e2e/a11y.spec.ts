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
