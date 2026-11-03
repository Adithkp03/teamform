import { expect, test, type APIRequestContext } from '@playwright/test';
import { signup, uniqueEmail } from './helpers';

// Regression coverage for two review findings:
//  1. A loadMore page request in flight when the filter input changes must be
//     discarded IMMEDIATELY on input change - even during the 350ms debounce
//     window before the refresh fires - so old-filter rows can never append.
//  2. Server conflicts (joining a full team) surface as an error toast.

const API = 'http://localhost:3100';

async function apiSignup(request: APIRequestContext, name: string): Promise<{ token: string }> {
  const email = uniqueEmail(name);
  const idToken = Buffer.from(
    JSON.stringify({ uid: `test-${email}`, email, email_verified: true }),
  ).toString('base64url');
  const res = await request.post(`${API}/api/auth/firebase`, {
    data: { id_token: idToken, firebase_refresh_token: `fb-refresh-${email}`, display_name: name },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function apiCreateTeam(request: APIRequestContext, token: string, name: string) {
  const res = await request.post(`${API}/api/teams`, {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    data: { name },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).team;
}

test('loadMore response in flight is discarded the moment the filter input changes (debounce window)', async ({ page, request }) => {
  // Run-unique needles so accumulated data from other specs cannot collide.
  const run = Date.now().toString(36);
  const oldNeedle = `zzdelta${run}`;
  const newNeedle = `zzecho${run}`.slice(0, 30);
  // 26 old-filter teams (page size is 24, so page 2 exists) + 2 new-filter teams.
  for (let i = 0; i < 26; i++) {
    const u = await apiSignup(request, `DZ${run}${i}`);
    await apiCreateTeam(request, u.token, `${oldNeedle} team ${i}`.slice(0, 40));
  }
  for (let i = 0; i < 2; i++) {
    const u = await apiSignup(request, `EY${run}${i}`);
    await apiCreateTeam(request, u.token, `${newNeedle} team ${i}`.slice(0, 40));
  }

  await signup(page, `Viewer${run}`);
  await page.goto('/board');
  const list = page.locator('ul[aria-label="Teams looking for members"] li');
  await page.getByLabel('Search the whole board').fill(oldNeedle);
  await expect(list).toHaveCount(24, { timeout: 15000 });
  const loadMoreBtn = page.getByRole('button', { name: 'Load more teams' });
  await expect(loadMoreBtn).toBeVisible();

  // Deterministic delay: hold ONLY the paginated (cursor) board request for
  // 1200ms so it is guaranteed to be in flight across the whole 350ms
  // debounce window after the filter changes.
  await page.route('**/api/board**', async (route) => {
    if (route.request().url().includes('teams_cursor')) {
      await new Promise((r) => setTimeout(r, 1200));
    }
    await route.continue();
  });

  await loadMoreBtn.click();
  // The delayed page-2 request is now in flight. Change the filter input at
  // once: the input change itself must invalidate the in-flight request.
  await page.getByLabel('Search the whole board').fill(newNeedle);

  // DURING the debounce window (the refresh has not fired yet): the stale
  // page-2 response has not landed and must not append when it does.
  await expect(list).toHaveCount(24);

  // After the debounced refresh lands, only new-filter rows are shown...
  await expect(list).toHaveCount(2, { timeout: 15000 });
  await expect(list.first()).toContainText(newNeedle);

  // ...and after the delayed page-2 response finally lands (>1200ms after the
  // click), the old-filter rows must STILL not have been appended.
  await page.waitForTimeout(1600);
  await expect(list).toHaveCount(2);
  await expect(page.getByText(oldNeedle)).toHaveCount(0);
});

test('joining a full team surfaces the conflict as an error toast', async ({ page, request }) => {
  const leader = await apiSignup(request, 'FullLeader');
  const team = await apiCreateTeam(request, leader.token, 'Full House');
  expect(team.invite_code).toBeTruthy();
  // Team size max is 4 (E2E hackathon): leader + 3 joiners fills it.
  for (let i = 0; i < 3; i++) {
    const u = await apiSignup(request, `FullJoiner${i}`);
    const res = await request.post(`${API}/api/teams/join-by-code`, {
      headers: { authorization: `Bearer ${u.token}`, 'idempotency-key': crypto.randomUUID() },
      data: { code: team.invite_code },
    });
    expect(res.status(), await res.text()).toBe(201);
  }

  // The fifth person tries in the real UI: the 409 conflict must surface as a
  // visible error toast, not a silent failure.
  await signup(page, 'LateJoiner');
  await page.goto('/board');
  await page.getByRole('textbox', { name: 'Invite code' }).fill(team.invite_code);
  await page.getByRole('button', { name: 'Join with code' }).click();
  await expect(page.locator('[role="status"]')).toContainText('This team is full', { timeout: 10000 });
  // The failed join keeps the form usable: still on the board, button re-enabled.
  await expect(page.getByRole('button', { name: 'Join with code' })).toBeEnabled();
});
