import { expect, test } from '@playwright/test';
import { signup } from './helpers';

// Live updates with no refresh: two independent browser sessions (SSE).
test('board and team pages update live across sessions without refresh', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const C = await ctxC.newPage();

  await signup(A, 'Live A');
  await signup(B, 'Live B');
  await signup(C, 'Live C');

  // A sits on the board; B creates a team -> appears for A without reload
  await A.goto('/board');
  await B.goto('/board');
  await B.getByLabel('Team name').fill('Live Team');
  await B.getByRole('button', { name: 'Create team' }).click();
  await expect(B).toHaveURL(/\/team\//);
  await expect(A.getByText('Live Team')).toBeVisible({ timeout: 10_000 });

  // A opens the team page; C joins by code -> member list updates without reload
  const inviteCode = (await B.locator('[aria-label="Invite members"] p.font-mono').innerText()).trim();
  await A.getByRole('link', { name: 'View', exact: true }).first().click();
  await expect(A).toHaveURL(/\/team\//);
  await expect(A.getByText('1/4 members')).toBeVisible();
  await C.goto('/board');
  await C.getByRole('textbox', { name: 'Invite code' }).fill(inviteCode);
  await C.getByRole('button', { name: 'Join with code' }).click();
  await expect(C).toHaveURL(/\/team\//);
  await expect(A.getByText('2/4 members')).toBeVisible({ timeout: 10_000 });
  await expect(A.getByText('Live C')).toBeVisible({ timeout: 10_000 });

  await ctxA.close(); await ctxB.close(); await ctxC.close();
});
