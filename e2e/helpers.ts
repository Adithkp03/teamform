import { expect, type Page } from '@playwright/test';

let seq = 0;
export const uniqueEmail = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now()}-${seq++}@e2e.dev`;

/** Sign up through the real UI form; lands on /profile. */
export async function signup(page: Page, name: string): Promise<string> {
  const email = uniqueEmail(name);
  await page.goto('/login');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-9');
  await page.locator('form').getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/profile/);
  return email;
}

/** Move focus with Tab until the matching element is focused. */
export async function tabUntilFocused(page: Page, selector: string, maxTabs = 25): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    const match = await page.evaluate((sel) => {
      const el = document.activeElement;
      if (!el) return false;
      // Support "selector::text(needle)" so callers can match by visible text
      // (el.matches() cannot take Playwright's :has-text pseudo).
      const [css, needle] = sel.split('::text(');
      if (!el.matches(css)) return false;
      return needle ? (el.textContent ?? '').includes(needle.replace(/\)$/, '')) : true;
    }, selector);
    if (match) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${selector} within ${maxTabs} presses`);
}
