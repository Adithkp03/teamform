import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';

/** Self-serve own-data export (privacy review): the caller gets everything
 *  stored about them, explicit columns only - never credential material. */

beforeAll(migrate);

describe('GET /api/me/export', () => {
  beforeEach(() => resetDb());

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me/export' })).statusCode).toBe(401);
  });

  it('returns the caller\'s own data across all stores, with no credential material', async () => {
    const leader = await makeUser('Leader', ['react']);
    const me = await makeUser('Me', ['node']);
    const team = (await createTeam(leader.token, 'Export Team')).json().team;
    // I request to join their team
    await app.inject({ method: 'POST', url: `/api/teams/${team.id}/requests`, headers: { ...auth(me.token), 'idempotency-key': idemKey() }, payload: {} });
    // I appear in their suggestions and vote (creates impression + feedback for me as candidate/voter)
    await app.inject({ method: 'GET', url: '/api/suggestions', headers: auth(leader.token) });
    const fb = await app.inject({ method: 'POST', url: '/api/suggestions/feedback', headers: { ...auth(leader.token), 'idempotency-key': idemKey() }, payload: { candidate_id: me.id, useful: true } });
    expect(fb.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/me/export', headers: auth(me.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.id).toBe(me.id);
    expect(body.profile.display_name).toBe('Me');
    expect(body.profile.skills).toEqual(['node']);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('firebase_refresh');
    expect(raw).not.toContain(leader.id); // nobody else's identity leaks into MY export beyond team context
    expect(body.join_requests.length).toBe(1);
    expect(body.join_requests[0].team_name).toBe('Export Team');
    expect(body.suggestion_impressions.serves_recorded).toBeGreaterThan(0);
    expect(body.retention_note).toContain('Audit-log');

    // the voter's own export shows their vote
    const voterRes = await app.inject({ method: 'GET', url: '/api/me/export', headers: auth(leader.token) });
    expect(voterRes.json().suggestion_feedback.length).toBe(1);
    expect(voterRes.json().suggestion_feedback[0].useful).toBe(true);
    expect(voterRes.json().team_memberships[0].role).toBe('leader');
  });
});
