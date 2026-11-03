import { expect, test } from '@playwright/test';
import { signup } from './helpers';

// The outbound connect journey through the real UI: a team member invites a
// person from the board's people tab; the invitee sees the invitation on
// their board and accepts; both sides see the membership. Also covers the
// requester self-cancel added with the same journey work.
test('invite from board -> invitation inbox -> accept -> teammate', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  await signup(A, 'Invite Lead');
  await signup(B, 'Invite Guest');

  // A creates a team
  await A.goto('/board');
  await A.getByLabel('Team name').fill('Invite Team');
  await A.getByRole('button', { name: 'Create team' }).click();
  await expect(A).toHaveURL(/\/team\//);

  // A invites B from the people tab
  await A.goto('/board');
  await A.getByRole('tab', { name: /People looking/ }).click();
  const card = A.locator('li', { hasText: 'Invite Guest' }).first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Invite to your team' }).click();
  await expect(A.getByText('Invitation sent - they will see it on their board.')).toBeVisible();

  // A's team page shows the pending invitation
  await A.goto(A.url().split('/board')[0] + '/board'); // stay on board
  await A.locator('a', { hasText: 'Invite Team' }).first().click();
  await expect(A.getByText('Invited, waiting for an answer (1)')).toBeVisible();

  // B sees the invitation on the board and accepts -> lands on the team page
  await B.goto('/board');
  await expect(B.getByText('Teams inviting you (1)')).toBeVisible();
  await B.getByRole('button', { name: 'Accept' }).click();
  await expect(B).toHaveURL(/\/team\//);
  await expect(B.getByText('2/4 members')).toBeVisible();

  // A sees B as a member and no pending invitation
  await A.reload();
  await expect(A.getByText('2/4 members')).toBeVisible();
  await expect(A.getByText('Invited, waiting for an answer')).toHaveCount(0);
});

test('requester cancels their own pending request from the UI state', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  await signup(A, 'Cancel Lead');
  await signup(B, 'Cancel Asker');

  await A.goto('/board');
  await A.getByLabel('Team name').fill('Cancel Team');
  await A.getByRole('button', { name: 'Create team' }).click();
  await expect(A).toHaveURL(/\/team\//);

  // B requests to join, then cancels the pending request from the board.
  await B.goto('/board');
  await B.getByRole('button', { name: 'Request to join' }).first().click();
  await expect(B.getByText('Request sent - the team leader will review it.')).toBeVisible();

  // Pending state survives a reload (server-backed), then cancel works.
  await B.reload();
  await expect(B.getByText('Request pending - the leader will review it')).toBeVisible();
  await B.getByRole('button', { name: 'Cancel your join request to Cancel Team' }).click();
  await expect(B.getByText('Request cancelled.')).toBeVisible();
  await B.reload();
  await expect(B.getByRole('button', { name: 'Request to join' }).first()).toBeVisible();

  // The leader never sees a decided-away request as pending.
  await A.reload();
  await expect(A.locator('li', { hasText: 'Cancel Asker' })).toHaveCount(0);
});
