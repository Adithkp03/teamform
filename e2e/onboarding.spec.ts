import { test, expect } from '@playwright/test';
import { signup } from './helpers';

test('first-run checklist guides profile, team, suggestions and stays dismissed', async ({ page }) => {
  await signup(page, 'Onboarding User');
  await page.getByLabel('Skills (comma separated)').fill('react, node');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL('**/board');

  const checklist = page.getByRole('region', { name: 'Getting started checklist' });
  await expect(checklist).toBeVisible();
  await expect(checklist.getByText('Complete your profile with your skills')).toHaveClass(/line-through/);
  await expect(checklist.getByText('Join a team below, start your own, or use an invite code')).toBeVisible();

  // Step 3 completes after visiting suggestions.
  await page.goto('/suggestions');
  await expect(page.getByText('Suggested teammates')).toBeVisible();
  await page.goto('/board');
  await expect(page.getByRole('region', { name: 'Getting started checklist' }).getByText('Meet teammates picked for your skill set')).toHaveClass(/line-through/);

  // Dismiss persists across reloads.
  await page.getByRole('button', { name: 'Dismiss getting started checklist' }).click();
  await expect(page.getByRole('region', { name: 'Getting started checklist' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Getting started checklist' })).toHaveCount(0);
});

test('checklist disappears once the user is in a team', async ({ page }) => {
  await signup(page, 'Teamed User');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL('**/board');
  await expect(page.getByRole('region', { name: 'Getting started checklist' })).toBeVisible();
  await page.getByLabel('Team name').fill('Onboarding FC');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await page.waitForURL('**/team/**');
  await page.goto('/board');
  await expect(page.getByRole('region', { name: 'Getting started checklist' })).toHaveCount(0);
});
