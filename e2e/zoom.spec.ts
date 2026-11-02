import { test, expect, type Page } from '@playwright/test';
import { signup } from './helpers';

// Browser zoom at 200% shrinks the CSS-pixel viewport; CSS zoom on the root
// element gives the same layout stress in automation. Checks that controls
// stay on screen and keyboard focus remains visible and inside the viewport.
async function expectUsableAtZoom(page: Page, path: string, label: string) {
  await page.goto(path);
  await page.evaluate(() => { (document.documentElement as HTMLElement).style.zoom = '2'; });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  expect(overflow, `horizontal overflow at 200% zoom on ${label}`).toBe(false);

  // Every primary control must be within the viewport horizontally.
  const controls = await page.$$eval('button, input, select, textarea, a[href]', (els) =>
    els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && (r.left < -2 || r.right > window.innerWidth + 2);
    }).map((el) => `${el.tagName}:${(el.textContent || (el as HTMLInputElement).placeholder || '').trim().slice(0, 30)}`),
  );
  expect(controls, `controls offscreen at 200% zoom on ${label}`).toEqual([]);

  // Keyboard focus lands on a visible element inside the viewport with an outline.
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    if (!el || el === document.body) return { ok: false, why: 'focus on body' };
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const outlined = style.outlineWidth !== '0px' && style.outlineStyle !== 'none';
    const inside = r.left >= -2 && r.right <= window.innerWidth + 2 && r.width > 0 && r.height > 0;
    return { ok: outlined && inside, why: `outlined=${outlined} inside=${inside} rect=${JSON.stringify(r)}` };
  });
  expect(focus.ok, `focus not visible/in-viewport at 200% zoom on ${label}: ${focus.why}`).toBe(true);
  await page.evaluate(() => { (document.documentElement as HTMLElement).style.zoom = ''; });
}

test('200% zoom keeps controls reachable and focus visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectUsableAtZoom(page, '/login', 'login');

  await signup(page, 'Zoom User');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL('**/board');
  await page.getByLabel('Team name').fill('Zoom Team');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await page.waitForURL('**/team/**');

  await page.setViewportSize({ width: 1280, height: 800 });
  await expectUsableAtZoom(page, '/board', 'board');
  await expectUsableAtZoom(page, '/profile', 'profile');
  await expectUsableAtZoom(page, '/suggestions', 'suggestions');
});
