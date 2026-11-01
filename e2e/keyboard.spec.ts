import { expect, test } from '@playwright/test';
import { tabUntilFocused, uniqueEmail } from './helpers';

// Keyboard-only: skip link, tab-based signup, keyboard nav between pages.
test('signup and navigation are operable with a keyboard only', async ({ page }) => {
  await page.goto('/login');

  // Tabbing reaches the skip link (the login email field holds initial focus)
  await tabUntilFocused(page, 'a.skip-link', 15);
  const skip = page.locator('a.skip-link');
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible(); // focus reveals the visually-hidden skip link

  // Reach and activate the "Create account" tab
  await tabUntilFocused(page, '[role="tab"][aria-selected]', 5);
  await tabUntilFocused(page, 'button::text(Create account)');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Display name')).toBeVisible();

  // Fill the form by tabbing and typing only
  await tabUntilFocused(page, '#name');
  await page.keyboard.type('Keys User');
  await page.keyboard.press('Tab');
  await page.keyboard.type(uniqueEmail('keys'));
  await page.keyboard.press('Tab');
  await page.keyboard.type('e2e-password-9');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/profile/, { timeout: 15_000 });

  // Save the profile with the keyboard, then navigate via the nav links
  await tabUntilFocused(page, 'button::text(Save)', 15);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/board/, { timeout: 15_000 });
  // SPA navigation removed the focused Save button; reload so sequential
  // focus starts from the document (standard starting point for keyboard use)
  await page.reload();
  await tabUntilFocused(page, 'a::text(Suggestions)', 15);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/suggestions/);
});
