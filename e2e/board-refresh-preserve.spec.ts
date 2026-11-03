import { test, expect, type Page } from '@playwright/test';
import pg from 'pg';
import { signup, uniqueEmail } from './helpers';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/teamform_e2e';
const API = 'http://localhost:3100';

// Regression suite for the live-update snapback: an SSE-triggered refresh
// used to replace the board with page 1 (24 rows), discarding loaded pages
// and resurrecting a finished Load-more. Totals are computed from the DB with
// the board's exact visibility predicate, so these specs are suite-order
// independent; every wait is anchored on a badge count (auto-retried), never
// on a fixed sleep.

const badge = (page: Page, n: number, more: boolean) =>
  page.getByRole('tab', { name: new RegExp(`^Teams looking \\(${n}${more ? '\\+' : ''}\\)$`) });

// Exact simulation of the client's coverage-restoring refresh: pages of
// min(200, max(24, remaining)) until the previously loaded count is restored
// or the cursor is exhausted; the server emits a cursor iff it returned a
// full page. Deterministic for a known loaded count and row availability.
const simRefresh = (target: number, avail: number) => {
  let len = 0;
  let more = false;
  for (;;) {
    const limit = Math.min(200, Math.max(24, target - len));
    const rows = Math.min(limit, avail - len);
    len += rows;
    if (len >= target || rows < limit) break;
  }
  // One-row lookahead server: a cursor survives iff rows exist beyond what
  // the refresh actually loaded.
  more = avail > len;
  return { len, more };
};

// Click Load-more through any overflow the refresh left, anchoring each
// landing state on the badge, until the list is exhausted at `final`.
const exhaust = async (page: Page, from: { len: number; more: boolean }, final: number) => {
  let len = from.len;
  let more = from.more;
  while (more) {
    // A racing refresh cycle may already have loaded the remainder, removing
    // the button before this click; that convergence is the healthy path.
    const btn = page.getByRole('button', { name: 'Load more teams' });
    if ((await btn.count()) === 0) break;
    await btn.click();
    len = Math.min(len + 24, final);
    more = len < final;
    await expect.poll(() => badgeCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(len);
  }
  await expect(badge(page, final, false)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Load more teams' })).toHaveCount(0);
};

const visibleTeamCount = async (client: pg.Client) => {
  const { rows: [cnt] } = await client.query(
    // Must match the API's board query exactly, including the leader JOIN:
    // a team whose leader profile is gone is invisible on the board, and
    // counting it here would make the badge-anchored waits hang forever.
    `SELECT count(*)::int AS n FROM teams t JOIN hackathons h ON h.id = t.hackathon_id
     JOIN profiles lp ON lp.id = t.leader_id
     WHERE t.looking_for_members AND t.member_count < h.team_size_max`);
  return cnt.n as number;
};

// Independent oracle: the rendered cards themselves. The unique team links
// on the board must equal the expected coverage - no duplicates, no loss,
// whatever the badge claims.
const expectVisibleTeams = async (page: Page, n: number) => {
  const hrefs = await page.locator('#main a[href^="/team/"]').evaluateAll(
    (els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')));
  expect(new Set(hrefs).size).toBe(n);
};

// The displayed team count, parsed from the badge (N) / (N+). Monotonic
// threshold waits: one click owes at least one page, but a racing refresh or
// the demand pump may legitimately deliver MORE than one page between
// assertions - asserting an exact intermediate count flakes on healthy
// over-delivery, especially on slower CI.
const badgeCount = async (page: Page) => {
  const txt = await page.getByRole('tab', { name: /^Teams looking \(\d+\+?\)$/ }).textContent();
  const m = txt?.match(/\((\d+)\+?\)/);
  return m ? Number(m[1]) : -1;
};

const loadAllPages = async (page: Page, total: number) => {
  await expect(badge(page, 24, true)).toBeVisible();
  for (let loaded = 24; loaded < total; loaded += 24) {
    const want = Math.min(loaded + 24, total);
    // Exactly one click per page: a click racing a live refresh queues its
    // demand and the board advances once the refresh settles - no retries.
    await page.getByRole('button', { name: 'Load more teams' }).click();
    await expect.poll(() => badgeCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(want);
  }
  await expect(page.getByRole('button', { name: 'Load more teams' })).toHaveCount(0);
  await expect(badge(page, total, false)).toBeVisible({ timeout: 15000 });
  await expectVisibleTeams(page, total);
};

const apiTeamCreator = async (request: any, email: string, name: string) => {
  const idToken = Buffer.from(
    JSON.stringify({ uid: `test-${email}`, email, email_verified: true }),
  ).toString('base64url');
  const ex = await request.post(`${API}/api/auth/firebase`, {
    data: { id_token: idToken, firebase_refresh_token: `fb-refresh-${email}`, display_name: name },
  });
  const { token } = await ex.json();
  return (teamName: string) => request.post(`${API}/api/teams`, {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    data: { name: teamName },
  });
};

const cleanup = async (client: pg.Client, prefix: string, teamNames: string[], emails: string[]) => {
  await client.query(`DELETE FROM teams WHERE name LIKE $1 OR name = ANY($2)`, [`${prefix}%`, teamNames]);
  await client.query(`DELETE FROM profiles WHERE display_name LIKE $1`, [`${prefix}%`]);
  const { rows: trig } = await client.query(`SELECT id FROM profiles WHERE email = ANY($1)`, [emails]);
  for (const t of trig) {
    await client.query(`DELETE FROM auth_refresh_tokens WHERE user_id = $1`, [t.id]);
    await client.query(`DELETE FROM profiles WHERE id = $1`, [t.id]);
  }
  await client.end();
};

test('live-update refresh preserves loaded pages, cursors and Load-more state', async ({ page, request }) => {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const { rows: [h] } = await client.query(`SELECT id FROM hackathons LIMIT 1`);
  const stamp = Date.now().toString(36);
  const prefix = `Preserve ${stamp}`;
  const triggerEmail = uniqueEmail('preserve-trigger');
  const trigger2Email = uniqueEmail('preserve-trigger2');
  const triggerName = `Trigger ${stamp}`;
  const trigger2Name = `Trigger Two ${stamp}`;

  // Seed 30 so the spec paginates even standalone (page size is 24).
  const { rows: leaders } = await client.query(
    `INSERT INTO profiles (id, display_name, is_seed, looking_for_team)
     SELECT gen_random_uuid(), $1 || ' Leader ' || g, true, false FROM generate_series(1, 30) g RETURNING id`, [prefix]);
  for (let i = 0; i < 30; i++) {
    const { rows: [t] } = await client.query(
      `INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id`,
      [h.id, `${prefix} Team ${String(i).padStart(2, '0')}`, leaders[i].id, `PRV${stamp}${i}`.slice(0, 24)]);
    await client.query(
      `INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'leader')`,
      [t.id, h.id, leaders[i].id]);
  }

  try {
    const total = await visibleTeamCount(client);
    // The bulk SQL seed wrote one domain event per team; consume them so the
    // only live event during the assertions is the API-driven trigger's.
    await client.query(`DELETE FROM domain_events`);
    // The SQL seeds above bypass the API layer, so the 1s board cache can
    // still hold a pre-seed page 1 cached during the previous spec (same
    // cache key: limit + empty cursors). Outlive the TTL before the first
    // board read, or the first page (and its cursor) can come from deleted
    // rows - the stale cursor then pages an empty result set.
    await page.waitForTimeout(1100);
    await signup(page, 'Preserve Viewer');
    await page.goto('/board');
    await loadAllPages(page, total);

    // Insertion: a new team from another user arrives via the SSE refresh;
    // coverage survives (no snapback to page 1), cards are not duplicated,
    // and Load-more offers exactly the overflow.
    const mkTeam = await apiTeamCreator(request, triggerEmail, 'Trigger User');
    expect((await mkTeam(triggerName)).ok()).toBe(true);
    await expect(page.getByRole('link', { name: triggerName, exact: true })).toBeVisible();
    const afterInsert = simRefresh(total, total + 1);
    // (N+) while converging, exact (N) once the remainder loaded - both are
    // truthful, so wait for the threshold, not one exact rendering.
    await expect.poll(() => badgeCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(afterInsert.len);
    await expect(page.getByRole('link', { name: `${prefix} Team 01`, exact: true })).toHaveCount(1);
    await expect(page.getByRole('link', { name: `${prefix} Team 29`, exact: true })).toHaveCount(1);
    await exhaust(page, afterInsert, total + 1);
    await expectVisibleTeams(page, total + 1);

    // Removal: a loaded team stops being board-visible while another is
    // inserted; the same refresh drops the gone team and keeps coverage.
    await client.query(`DELETE FROM teams WHERE name = $1`, [`${prefix} Team 15`]);
    // One team per person per hackathon: the second insertion needs its own user.
    const mkTeam2 = await apiTeamCreator(request, trigger2Email, 'Trigger Two');
    expect((await mkTeam2(trigger2Name)).ok()).toBe(true);
    await expect(page.getByRole('link', { name: trigger2Name, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `${prefix} Team 15`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: `${prefix} Team 01`, exact: true })).toHaveCount(1);
    const afterRemoval = simRefresh(total + 1, total + 1);
    await expect.poll(() => badgeCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(afterRemoval.len);
    await exhaust(page, afterRemoval, total + 1);
    await expectVisibleTeams(page, total + 1);

    // Filter change resets to the filtered result set (Team 10-19 minus the
    // deleted Team 15 = 9); clearing returns to page 1 of the full set.
    await page.getByLabel('Search the whole board').fill(`${prefix} Team 1`);
    await expect(badge(page, 9, false)).toBeVisible();
    await expect(page.getByRole('link', { name: `${prefix} Team 12`, exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Load more teams' })).toHaveCount(0);
    await expectVisibleTeams(page, 9);

    // Rapid re-filter inside the debounce window: only the latest query may
    // win; a stale filtered response must not land last.
    await page.getByLabel('Search the whole board').fill('zzz-no-match');
    await page.getByLabel('Search the whole board').fill('');
    await expect(badge(page, 24, true)).toBeVisible();
    await expect(page.getByRole('link', { name: trigger2Name, exact: true })).toBeVisible();
  } finally {
    await cleanup(client, prefix, [triggerName, trigger2Name], [triggerEmail, trigger2Email]);
  }
});

// The server caps one board page at 200 rows. A user who loaded past 200 must
// not lose coverage on a live update: the refresh restores it with sequential
// cursor pages, so the oldest loaded card survives and nothing duplicates.
test('live-update refresh preserves coverage past the 200-row page cap', async ({ page, request }) => {
  test.setTimeout(120000);
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const { rows: [h] } = await client.query(`SELECT id FROM hackathons LIMIT 1`);
  const stamp = Date.now().toString(36);
  const prefix = `Wide ${stamp}`;
  const triggerEmail = uniqueEmail('wide-trigger');
  const triggerName = `Wide Trigger ${stamp}`;

  const { rows: leaders } = await client.query(
    `INSERT INTO profiles (id, display_name, is_seed, looking_for_team)
     SELECT gen_random_uuid(), $1 || ' Leader ' || g, true, false FROM generate_series(1, 205) g RETURNING id`, [prefix]);
  await client.query(
    `INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at)
     SELECT $1, $2 || ' Team ' || lpad(u.ord::text, 3, '0'), u.id, ($3 || u.ord::text), now() + interval '7 days'
     FROM unnest($4::uuid[]) WITH ORDINALITY AS u(id, ord)`,
    [h.id, prefix, `PW${stamp}`.slice(0, 20), leaders.map((l: any) => l.id)]);
  await client.query(
    `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
     SELECT t.id, $1, t.leader_id, 'leader' FROM teams t WHERE t.name LIKE $2`,
    [h.id, `${prefix}%`]);

  try {
    const total = await visibleTeamCount(client); // >= 205, plus earlier specs' leftovers
    // Same reasoning as above: consume the bulk seed's domain events first.
    await client.query(`DELETE FROM domain_events`);
    // The SQL seeds above bypass the API layer, so the 1s board cache can
    // still hold a pre-seed page 1 cached during the previous spec (same
    // cache key: limit + empty cursors). Outlive the TTL before the first
    // board read, or the first page (and its cursor) can come from deleted
    // rows - the stale cursor then pages an empty result set.
    await page.waitForTimeout(1100);
    await signup(page, 'Wide Viewer');
    await page.goto('/board');
    await loadAllPages(page, total);

    const mkTeam = await apiTeamCreator(request, triggerEmail, 'Wide Trigger');
    expect((await mkTeam(triggerName)).ok()).toBe(true);

    // The refresh must page past the 200-row cap: newest trigger and oldest
    // seeded card both survive once the overflow is exhausted, no duplicates.
    await expect(page.getByRole('link', { name: triggerName, exact: true })).toBeVisible();
    const afterInsert = simRefresh(total, total + 1);
    // (N+) while converging, exact (N) once the remainder loaded - both are
    // truthful, so wait for the threshold, not one exact rendering.
    await expect.poll(() => badgeCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(afterInsert.len);
    await expect(page.getByRole('link', { name: `${prefix} Team 100`, exact: true })).toHaveCount(1);
    await exhaust(page, afterInsert, total + 1);
    await expect(page.getByRole('link', { name: `${prefix} Team 001`, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `${prefix} Team 205`, exact: true })).toHaveCount(1);
    await expectVisibleTeams(page, total + 1);
  } finally {
    await cleanup(client, prefix, [triggerName], [triggerEmail]);
  }
});
