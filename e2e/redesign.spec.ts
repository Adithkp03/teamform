import { test, expect } from '@playwright/test';
import { signup } from './helpers';
test('light layout fits phone and desktop; search filters loaded cards', async ({ page }, testInfo) => {
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
});
