import { beforeAll, beforeEach, afterEach, describe, expect, test } from 'vitest';
import { app, migrate, resetDb, makeUser, makeEmailUser, auth, idemKey, createTeam } from './helpers.js';
import { pool } from '../src/db.js';

beforeAll(migrate);
beforeEach(() => resetDb());

const ORG = 'organizer@hackathon.dev';
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env.ORGANIZER_EMAILS; process.env.ORGANIZER_EMAILS = ORG; });
afterEach(() => { if (savedEnv === undefined) delete process.env.ORGANIZER_EMAILS; else process.env.ORGANIZER_EMAILS = savedEnv; });

async function requestJoin(token: string, teamId: string) {
  return app.inject({ method: 'POST', url: `/api/teams/${teamId}/requests`, headers: { ...auth(token), 'idempotency-key': idemKey() }, payload: {} });
}

describe('organizer authorization', () => {
  test('non-organizer and anonymous callers are refused; unset allowlist refuses everyone', async () => {
    const u = await makeEmailUser('Regular', 'regular@test.dev');
    const anon = await app.inject({ method: 'GET', url: '/api/organizer/overview' });
    expect(anon.statusCode).toBe(401);
    const nonOrg = await app.inject({ method: 'GET', url: '/api/organizer/overview', headers: auth(u.token) });
    expect(nonOrg.statusCode).toBe(403);

    delete process.env.ORGANIZER_EMAILS;
    const org = await makeEmailUser('Org', ORG);
    const nobody = await app.inject({ method: 'GET', url: '/api/organizer/overview', headers: auth(org.token) });
    expect(nobody.statusCode).toBe(403);
    expect(nobody.json().error.message).toMatch(/No organizers/);
  });

  test('overview reports event config and live counts', async () => {
    const org = await makeEmailUser('Org', ORG);
    const leader = await makeUser('Leader');
    await createTeam(leader.token, 'Visible Team');
    const res = await app.inject({ method: 'GET', url: '/api/organizer/overview', headers: auth(org.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.event.slug).toBe('ps1');
    expect(body.teams).toBe(1);
    expect(body.participants).toBe(2); // org + leader; no seed rows
  });
});

describe('organizer audit search and export', () => {
  test('audit search filters by action/team/user and survives team deletion', async () => {
    const org = await makeEmailUser('Org', ORG);
    const leader = await makeUser('Leader');
    const team = (await createTeam(leader.token, 'Doomed Team')).json().team;
    // Last member leaves: team is deleted. Its audit trail must remain.
    await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(leader.token) });
    const gone = await app.inject({ method: 'GET', url: `/api/teams/${team.id}`, headers: auth(leader.token) });
    expect(gone.statusCode).toBe(404);

    const byTeam = await app.inject({ method: 'GET', url: `/api/organizer/audit?team_id=${team.id}`, headers: auth(org.token) });
    expect(byTeam.statusCode).toBe(200);
    const actions = byTeam.json().audit.map((r: any) => r.action);
    expect(actions).toContain('team_created');
    expect(actions).toContain('team_deleted');

    const byAction = await app.inject({ method: 'GET', url: `/api/organizer/audit?action=team_deleted`, headers: auth(org.token) });
    expect(byAction.json().audit.length).toBe(1);
    const byActor = await app.inject({ method: 'GET', url: `/api/organizer/audit?user_id=${leader.id}`, headers: auth(org.token) });
    expect(byActor.json().audit.length).toBeGreaterThanOrEqual(2);
  });

  test('CSV export carries the filtered rows', async () => {
    const org = await makeEmailUser('Org', ORG);
    const leader = await makeUser('Leader');
    await createTeam(leader.token, 'Export Team');
    const res = await app.inject({ method: 'GET', url: '/api/organizer/audit/export?action=team_created', headers: auth(org.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('id,created_at,action,actor_name,subject_name,team_name,team_id,metadata');
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('team_created');
    expect(lines[1]).toContain('Export Team');
  });
});

describe('stuck request resolution', () => {
  test('stuck listing finds aged pending requests; organizer cancels with audited reason', async () => {
    const org = await makeEmailUser('Org', ORG);
    const leader = await makeUser('Leader');
    const joiner = await makeUser('Joiner');
    const team = (await createTeam(leader.token, 'Slow Team')).json().team;
    const jr = (await requestJoin(joiner.token, team.id)).json().request;
    // Age the request beyond the 24h default threshold.
    await pool.query(`UPDATE join_requests SET created_at = now() - interval '30 hours' WHERE id = $1`, [jr.id]);

    const stuck = await app.inject({ method: 'GET', url: '/api/organizer/requests/stuck', headers: auth(org.token) });
    expect(stuck.statusCode).toBe(200);
    expect(stuck.json().stuck.map((r: any) => r.id)).toContain(jr.id);

    const resolved = await app.inject({
      method: 'POST', url: `/api/organizer/requests/${jr.id}/resolve`,
      headers: auth(org.token), payload: { reason: 'Participant asked support to withdraw' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('cancelled');

    const again = await app.inject({
      method: 'POST', url: `/api/organizer/requests/${jr.id}/resolve`,
      headers: auth(org.token), payload: { reason: 'duplicate click' },
    });
    expect(again.statusCode).toBe(409);

    const audit = await app.inject({ method: 'GET', url: `/api/organizer/audit?action=organizer_request_cancelled`, headers: auth(org.token) });
    const row = audit.json().audit[0];
    expect(row.metadata.reason).toBe('Participant asked support to withdraw');
    expect(row.metadata.user_id).toBe(joiner.id);
  });
});

describe('event settings', () => {
  test('organizer updates settings with audit trail and over-max report; invalid combos refused', async () => {
    const org = await makeEmailUser('Org', ORG);
    const leader = await makeUser('Leader');
    // Team of 3: leader + 2 joins via code (max is 4 in resetDb).
    const team = (await createTeam(leader.token, 'Big Team')).json().team;
    for (const n of ['M1', 'M2']) {
      const m = await makeUser(n);
      await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(m.token), 'idempotency-key': idemKey() }, payload: { code: team.invite_code } });
    }
    const bad = await app.inject({ method: 'PUT', url: '/api/organizer/event', headers: auth(org.token), payload: { team_size_min: 4, team_size_max: 2 } });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({ method: 'PUT', url: '/api/organizer/event', headers: auth(org.token), payload: { team_size_max: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().event.team_size_max).toBe(2);
    expect(res.json().teams_over_max).toBe(1); // Big Team has 3 members

    const audit = await app.inject({ method: 'GET', url: '/api/organizer/audit?action=event_settings_updated', headers: auth(org.token) });
    expect(audit.json().audit[0].metadata.after.team_size_max).toBe(2);
    expect(audit.json().audit[0].metadata.before.team_size_max).toBe(4);
  });
});

describe('matching metrics', () => {
  test('serving suggestions records impressions; feedback and outcomes are reported', async () => {
    const org = await makeEmailUser('Org', ORG);
    const me = await makeUser('Me', ['react'], 330);
    const c1 = await makeUser('C1', ['node', 'go'], 330);
    await makeUser('C2', ['python'], -300);

    const served = await app.inject({ method: 'GET', url: '/api/suggestions', headers: auth(me.token) });
    expect(served.statusCode).toBe(200);
    expect(served.json().scoring_status).toMatch(/heuristic/);
    // Impressions are fire-and-forget; give the batch insert a tick.
    await new Promise((r) => setTimeout(r, 100));

    const fb = await app.inject({ method: 'POST', url: '/api/suggestions/feedback', headers: auth(me.token), payload: { candidate_id: c1.id, useful: true } });
    expect(fb.statusCode).toBe(200);
    // Changing the vote updates rather than duplicates.
    await app.inject({ method: 'POST', url: '/api/suggestions/feedback', headers: auth(me.token), payload: { candidate_id: c1.id, useful: false } });

    const m = await app.inject({ method: 'GET', url: '/api/organizer/matching', headers: auth(org.token) });
    const body = m.json();
    expect(body.impressions).toBeGreaterThanOrEqual(2);
    expect(body.users_served).toBe(1);
    expect(body.feedback_votes).toBe(1);
    expect(body.feedback_useful).toBe(0);
    expect(body.note).toMatch(/Heuristic validation in progress/);
  });
});

describe('organizer identity binding', () => {
  test('an UNVERIFIED profile carrying an allowlisted email gets no organizer rights', async () => {
    // Legacy signup accepts any email with any password - ownership unproven.
    const org = await makeEmailUser('Not Really Org', ORG, { verified: false }); // email_verified_at NULL
    const res = await app.inject({ method: 'GET', url: '/api/organizer/overview', headers: auth(org.token) });
    expect(res.statusCode).toBe(403);

    // After consuming a verification link, the same profile is eligible.
    const { issueActionToken } = await import('../src/auth.js');
    const vt = await issueActionToken(org.id, 'verify');
    await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: vt } });
    const ok = await app.inject({ method: 'GET', url: '/api/organizer/overview', headers: auth(org.token) });
    expect(ok.statusCode).toBe(200);
  });

  test('a Firebase-verified identity with the allowlisted email is eligible', async () => {
    const { firebaseSignup } = await import('./helpers.js');
    const res = await firebaseSignup('Firebase Org', ORG, true);
    expect(res.statusCode).toBe(200);
    const token = res.json().token as string;
    const ok = await app.inject({ method: 'GET', url: '/api/organizer/overview', headers: auth(token) });
    expect(ok.statusCode).toBe(200);
  });
});
