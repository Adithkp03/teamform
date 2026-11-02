import { expect, type Page } from '@playwright/test';

let seq = 0;
export const uniqueEmail = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now()}-${seq++}@e2e.dev`;

/**
 * Provision a user through the API's offline Firebase seam (FIREBASE_TEST_MODE
 * is set on the e2e API server) and land on /profile as that user. The UI
 * sign-in form itself talks to real Firebase, which e2e cannot drive
 * without real accounts; everything after sign-in is exercised via the UI.
 */
export async function signup(page: Page, name: string): Promise<string> {
  const email = uniqueEmail(name);
  const idToken = Buffer.from(
    JSON.stringify({ uid: `test-${email}`, email, email_verified: true }),
  ).toString('base64url');
  const res = await page.request.post('http://localhost:3100/api/auth/firebase', {
    data: { id_token: idToken, firebase_refresh_token: `fb-refresh-${email}`, display_name: name },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  await page.goto('/login');
  await page.evaluate(({ token, uid, refresh }) => {
    localStorage.setItem('tf_token', token);
    localStorage.setItem('tf_uid', uid);
    localStorage.setItem('tf_refresh', refresh);
  }, { token: body.token, uid: body.user_id, refresh: body.refresh_token });
  await page.goto('/profile');
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
