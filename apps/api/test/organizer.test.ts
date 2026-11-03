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
    expect(body.note).toMatch(/Pair outcome/);
  });

  test('pair outcome counts only provable same-team joins after the impression', async () => {
    const org = await makeEmailUser('Org2', ORG);
    const me = await makeUser('Viewer', ['react'], 330);
    const cand = await makeUser('Cand', ['node', 'react'], 330);
    const solo = await makeUser('Solo', ['go'], 330);

    // Serve suggestions to the viewer: impressions land asynchronously.
    const served = await app.inject({ method: 'GET', url: '/api/suggestions', headers: auth(me.token) });
    expect(served.statusCode).toBe(200);
    expect(served.json().suggestions.length).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 100));

    // Post-impression pair formation: viewer creates a team, the served
    // candidate requests to join and the viewer accepts. Both join moments
    // are audit events after the impression.
    const team = (await createTeam(me.token, 'Pair Team')).json().team;
    const jr = await requestJoin(cand.token, team.id);
    expect(jr.statusCode).toBe(201);
    const accept = await app.inject({ method: 'POST', url: `/api/requests/${jr.json().request.id}/accept`, headers: auth(me.token) });
    expect(accept.statusCode).toBe(200);

    // One-sided join: the other served candidate founds their own team. The
    // old any-team-join proxy would have credited this; the pair metric must
    // not (the viewer is not on that team).
    expect((await createTeam(solo.token, 'Solo Team')).statusCode).toBe(201);

    const m = await app.inject({ method: 'GET', url: '/api/organizer/matching', headers: auth(org.token) });
    const body = m.json();
    expect(m.statusCode).toBe(200);
    expect(body.unique_pairs).toBeGreaterThanOrEqual(2);
    expect(body.pair_formed_within_7d).toBe(1);
  });

  test('pair formation stays provable after a member leaves (audit timestamps, not current membership)', async () => {
    const org = await makeEmailUser('Org3', ORG);
    const me = await makeUser('ViewerB', ['react'], 330);
    const cand = await makeUser('CandB', ['node', 'react'], 330);

    const served = await app.inject({ method: 'GET', url: '/api/suggestions', headers: auth(me.token) });
    expect(served.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    const team = (await createTeam(me.token, 'Churn Team')).json().team;
    const jr = await requestJoin(cand.token, team.id);
    expect(jr.statusCode).toBe(201);
    const accept = await app.inject({ method: 'POST', url: `/api/requests/${jr.json().request.id}/accept`, headers: auth(me.token) });
    expect(accept.statusCode).toBe(200);

    // The candidate leaves again: team_members no longer shows the pair at
    // all. The audit-derived metric must still prove it formed.
    const leave = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(cand.token) });
    expect(leave.statusCode).toBe(200);

    const m = await app.inject({ method: 'GET', url: '/api/organizer/matching', headers: auth(org.token) });
    expect(m.json().pair_formed_within_7d).toBe(1);
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

describe('retention sweep', () => {
  test('dry-run counts without deleting; real sweep prunes and is audited; audit_log itself is never swept', async () => {
    const org = await makeEmailUser('Org', ORG);
    const u = await makeUser('U');
    // stale + fresh rows across the sweep targets
    await pool.query(`INSERT INTO rate_limits (key, window_start, count) VALUES
      ('old', now() - interval '3 hours', 5), ('live', now(), 1)`);
    await pool.query(`INSERT INTO metrics_rollups (window_start, route, requests) VALUES
      (now() - interval '15 days', '/api/old', 9), (now(), '/api/new', 1)`);
    await pool.query(`INSERT INTO suggestion_impressions (user_id, candidate_id, score) VALUES ($1, $2, 5)`, [u.id, org.id]);
    await pool.query(`UPDATE suggestion_impressions SET created_at = now() - interval '31 days'`);
    await pool.query(`INSERT INTO audit_log (hackathon_id, actor_id, action, metadata, created_at)
      SELECT id, $1, 'old_event', '{}', now() - interval '60 days' FROM hackathons`, [u.id]);

    const headers = { ...auth(org.token), 'content-type': 'application/json' };
    // dry-run: counts, no deletion, no audit write
    const dry = await app.inject({ method: 'POST', url: '/api/organizer/retention/sweep', headers, payload: { dry_run: true } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().dry_run).toBe(true);
    expect(dry.json().counts.rate_limits).toBe(1);
    expect(dry.json().counts.metrics_rollups).toBe(1);
    expect(dry.json().counts.suggestion_impressions).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM rate_limits WHERE key IN ('old','live')`)).rows[0].n).toBe(2);
    expect(dry.json().last_swept_at).toBeNull();

    // real sweep: deletes stale, keeps fresh, audits itself
    const real = await app.inject({ method: 'POST', url: '/api/organizer/retention/sweep', headers, payload: { dry_run: false } });
    expect(real.statusCode).toBe(200);
    expect(real.json().swept).toBe(true);
    expect(real.json().counts.rate_limits).toBe(1);
    expect((await pool.query(`SELECT key FROM rate_limits WHERE key IN ('old','live')`)).rows.map((r: any) => r.key)).toEqual(['live']);
    expect((await pool.query(`SELECT route FROM metrics_rollups`)).rows.map((r: any) => r.route)).toEqual(['/api/new']);
    expect((await pool.query(`SELECT count(*)::int AS n FROM suggestion_impressions`)).rows[0].n).toBe(0);
    expect(real.json().last_swept_at).not.toBeNull();
    const { rows: audit } = await pool.query(`SELECT action FROM audit_log ORDER BY created_at`);
    expect(audit.map((a: any) => a.action)).toContain('retention_sweep');
    expect(audit.map((a: any) => a.action)).toContain('old_event'); // audit rows never swept

    // empty body defaults to dry-run (a bare POST can never delete)
    const bare = await app.inject({ method: 'POST', url: '/api/organizer/retention/sweep', headers: auth(org.token) });
    expect(bare.statusCode).toBe(200);
    expect(bare.json().dry_run).toBe(true);
  });

  test('non-organizers cannot sweep', async () => {
    const u = await makeUser('R');
    expect((await app.inject({ method: 'POST', url: '/api/organizer/retention/sweep' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/organizer/retention/sweep', headers: auth(u.token) })).statusCode).toBe(403);
  });
});
