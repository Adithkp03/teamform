import { expect, test } from '@playwright/test';
import { signup } from './helpers';

// The whole team-formation flow through the real UI: signup -> profile ->
// create team -> join by code -> join request -> leader accepts -> leadership
// transfer on leave -> last member leaving deletes the team.
test('full team-formation flow end to end', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const C = await ctxC.newPage();

  await signup(A, 'Flow A');
  await signup(B, 'Flow B');
  await signup(C, 'Flow C');

  // A creates a team
  await A.goto('/board');
  await A.getByLabel('Team name').fill('Flow Team');
  await A.getByRole('button', { name: 'Create team' }).click();
  await expect(A).toHaveURL(/\/team\//);
  const inviteCode = (await A.locator('[aria-label="Invite code"] p.font-mono').innerText()).trim();
  expect(inviteCode.length).toBeGreaterThanOrEqual(8);
  await expect(A.getByText('Forming: needs at least 2 members.')).toBeVisible();

  // B joins with the invite code
  await B.goto('/board');
  await B.getByRole('textbox', { name: 'Invite code' }).fill(inviteCode);
  await B.getByRole('button', { name: 'Join team' }).click();
  await expect(B).toHaveURL(/\/team\//);
  await expect(B.getByText('2/4 members')).toBeVisible();

  // C sends a join request; A accepts as leader
  await C.goto('/board');
  await C.getByRole('button', { name: 'Request to join' }).first().click();
  await expect(C.getByText('Request sent to the team leader')).toBeVisible();
  await A.reload();
  await expect(A.locator('li p.font-medium', { hasText: 'Flow C' }).first()).toBeVisible();
  await A.getByRole('button', { name: 'Accept' }).click();
  await expect(A.getByText('3/4 members')).toBeVisible();
  // audit log records the join
  await expect(A.locator('section[aria-label="Audit history"], div:has-text("History")').first()).toBeVisible();

  // A (leader) leaves: leadership passes to B (earliest joiner)
  await A.getByRole('button', { name: 'Leave team' }).click();
  await B.reload();
  const bRow = B.locator('li', { hasText: 'Flow B' });
  await expect(bRow.getByText('leader')).toBeVisible();

  // B leaves; C is now the last member, and C leaving deletes the team.
  // Wait for each leave to COMMIT before navigating (navigation aborts the
  // in-flight request and the team would survive).
  await B.getByRole('button', { name: 'Leave team' }).click();
  await expect(B.getByText('You left the team')).toBeVisible();
  await C.goto('/board');
  await C.getByRole('link', { name: 'Flow Team' }).click();
  await expect(C).toHaveURL(/\/team\//);
  await C.getByRole('button', { name: 'Leave team' }).click();
  await expect(C.getByText('You left the team')).toBeVisible();
  await C.goto('/board');
  // the deleted team disappears (other specs share the database, so assert
  // this team's absence rather than a globally empty board)
  await expect(C.getByRole('link', { name: 'Flow Team' })).toHaveCount(0, { timeout: 10_000 });

  await ctxA.close(); await ctxB.close(); await ctxC.close();
});
