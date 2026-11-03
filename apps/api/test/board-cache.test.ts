import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, createTeam, idemKey } from './helpers.js';
import { pool } from '../src/db.js';
import { boardCacheSize, invalidateBoard, boardGeneration, storeBoard, BOARD_CACHE_TTL_MS, readBoard, boardPendingSize } from '../src/boardcache.js';
import { signToken } from '../src/auth.js';

// The board cache is a 1s-TTL in-process cache of the PUBLIC board payload.
// Authorization runs in the preHandler before any cache read; the payload is
// identical for every authenticated user. Same-instance mutations invalidate
// synchronously after commit (2xx only); cross-instance staleness is bounded
// by the TTL. These tests pin all of those guarantees.

beforeAll(migrate);
beforeEach(async () => { invalidateBoard(); await resetDb(); });

const board = (token?: string, limit?: number) =>
  app.inject({
    method: 'GET',
    url: `/api/board${limit ? `?limit=${limit}` : ''}`,
    headers: token ? auth(token) : {},
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('board cache', () => {
  test('warm hit returns the identical payload within the TTL', async () => {
    const u = await makeUser('A');
    await createTeam(u.token, 'CacheTeam');
    const r1 = await board(u.token);
    const r2 = await board(u.token);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().generated_at).toBe(r2.json().generated_at);
    expect(boardCacheSize()).toBeGreaterThan(0);
  });

  test('authorization is validated outside the cache: no token gets 401 even when warm', async () => {
    const u = await makeUser('A');
    await createTeam(u.token, 'WarmTeam');
    expect((await board(u.token)).statusCode).toBe(200); // warm it
    expect(boardCacheSize()).toBeGreaterThan(0);
    const unauth = await board();
    expect(unauth.statusCode).toBe(401);
  });

  test('read-your-write: team creation is visible immediately (post-commit invalidation)', async () => {
    const u = await makeUser('A');
    await board(u.token); // warm the cache WITHOUT the team
    const team = (await createTeam(u.token, 'FreshTeam', { looking_for_members: true })).json().team;
    const r = await board(u.token);
    expect(r.json().teams.map((t: any) => t.id)).toContain(team.id);
  });

  test('profile update (looking_for_team=false) reflects immediately', async () => {
    const u = await makeUser('A');
    const me = (lft: boolean) => app.inject({
      method: 'PUT', url: '/api/me', headers: auth(u.token),
      payload: { display_name: 'A', skills: ['x'], timezone: 'Asia/Calcutta', utc_offset_minutes: 330, looking_for_team: lft },
    });
    expect((await me(true)).statusCode).toBe(200);
    expect((await board(u.token)).json().people.map((p: any) => p.id)).toContain(u.id);
    expect((await me(false)).statusCode).toBe(200);
    expect((await board(u.token)).json().people.map((p: any) => p.id)).not.toContain(u.id);
  });

  test('leave updates the board member_count immediately', async () => {
    const leader = await makeUser('L');
    const joiner = await makeUser('J');
    const team = (await createTeam(leader.token, 'CountCache', { looking_for_members: true })).json().team;
    await app.inject({ method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(joiner.token), 'idempotency-key': `k-${Date.now()}-a` }, payload: { code: team.invite_code } });
    await board(leader.token); // warm with member_count 2
    expect((await board(leader.token)).json().teams.find((t: any) => t.id === team.id).member_count).toBe(2);
    const leave = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/leave`, headers: auth(joiner.token) });
    expect(leave.statusCode).toBe(200);
    expect((await board(leader.token)).json().teams.find((t: any) => t.id === team.id).member_count).toBe(1);
  });

  test('failed mutation (rolled back) does NOT invalidate the warm cache', async () => {
    const u = await makeUser('A');
    await createTeam(u.token, 'StableTeam');
    const warm = await board(u.token);
    const bad = await app.inject({
      method: 'POST', url: '/api/teams/join-by-code', headers: { ...auth(u.token), 'idempotency-key': `k-${Date.now()}-b` },
      payload: { code: 'NO_SUCH_CODE' },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const r = await board(u.token);
    expect(r.json().generated_at).toBe(warm.json().generated_at); // still the warm payload
  });

  test('staleness bound: out-of-band writes appear within the TTL', async () => {
    const u = await makeUser('A');
    const team = (await createTeam(u.token, 'StaleBound')).json().team;
    const warm = await board(u.token);
    // Simulate another instance's committed write: DB change with no local invalidation.
    await pool.query(`UPDATE teams SET name = 'RenamedByOtherInstance' WHERE id = $1`, [team.id]);
    const within = await board(u.token);
    expect(within.json().generated_at).toBe(warm.json().generated_at); // stale within TTL (documented bound)
    await sleep(BOARD_CACHE_TTL_MS + 150);
    const after = await board(u.token);
    expect(after.json().teams.find((t: any) => t.id === team.id).name).toBe('RenamedByOtherInstance');
  });

  test('read/mutation race: a read that started before an invalidation cannot repopulate a stale snapshot', async () => {
    const u = await makeUser('A');
    await board(u.token); // warm
    const genAtReadStart = boardGeneration(); // a concurrent read starts now (cache miss path)
    invalidateBoard();                          // a mutation commits + invalidates mid-read
    storeBoard('50||', { teams: [], people: [], generated_at: 'stale-snapshot' }, genAtReadStart);
    const r = await board(u.token);
    expect(r.json().generated_at).not.toBe('stale-snapshot'); // stale store was dropped
  });

  test('expired token gets 401 even with a warm cache (no served payload after auth expiry)', async () => {
    const u = await makeUser('A');
    await createTeam(u.token, 'ExpiryTeam');
    expect((await board(u.token)).statusCode).toBe(200); // warm
    const expired = signToken(u.id, undefined, '0s');
    await sleep(1100); // past exp AND past TTL so only auth can gate
    const r = await board(expired);
    expect(r.statusCode).toBe(401);
  });

  test('memory is bounded: many distinct limit values cannot grow the cache past the cap', async () => {
    const u = await makeUser('A');
    for (let i = 1; i <= 40; i++) await board(u.token, i);
    expect(boardCacheSize()).toBeLessThanOrEqual(32);
  });
});

describe('invite rotate idempotency', () => {
  test('a retried rotate replays the same code instead of invalidating it', async () => {
    const u = await makeUser('R');
    const team = (await createTeam(u.token, 'RotateTeam')).json().team;
    const key = `rot-${Date.now()}`;
    const r1 = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/invite/rotate`, headers: { ...auth(u.token), 'idempotency-key': key } });
    const r2 = await app.inject({ method: 'POST', url: `/api/teams/${team.id}/invite/rotate`, headers: { ...auth(u.token), 'idempotency-key': key } });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().invite_code).toBe(r1.json().invite_code);
    const { rows } = await pool.query(`SELECT invite_code FROM teams WHERE id = $1`, [team.id]);
    expect(rows[0].invite_code).toBe(r1.json().invite_code); // live code matches the replayed one
  });
});


describe('board in-flight read sharing', () => {
  test('concurrent same-key misses execute one loader', async () => {
    let calls = 0;
    const load = async () => { calls++; await sleep(20); return { value: 'fresh' }; };
    const rows = await Promise.all(Array.from({ length: 100 }, () => readBoard('shared', load)));
    expect(calls).toBe(1);
    expect(rows.every((r) => r === rows[0])).toBe(true);
    expect(boardPendingSize()).toBe(0);
  });
  test('post-invalidation read never joins old snapshot; old completion cannot remove new task', async () => {
    let oldDone!: (v: unknown) => void, newDone!: (v: unknown) => void;
    const oldRead = readBoard('race', () => new Promise((r) => { oldDone = r; }));
    await sleep(0);
    invalidateBoard();
    const newRead = readBoard('race', () => new Promise((r) => { newDone = r; }));
    await sleep(0);
    oldDone({ value: 'old' }); await oldRead;
    expect(boardPendingSize()).toBe(1);
    let extraCalls = 0;
    const joined = readBoard('race', async () => { extraCalls++; return {}; });
    newDone({ value: 'new' });
    expect(await joined).toEqual({ value: 'new' });
    await newRead;
    expect(extraCalls).toBe(0);
    expect(await readBoard('race', async () => ({}))).toEqual({ value: 'new' });
  });
  test('failed loader is removed and a later retry can succeed', async () => {
    await expect(readBoard('failure', async () => { throw new Error('db failed'); })).rejects.toThrow('db failed');
    expect(boardPendingSize()).toBe(0);
    expect(await readBoard('failure', async () => ({ ok: true }))).toEqual({ ok: true });
  });
  test('keys remain separate and in-flight bookkeeping is bounded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reads = Array.from({ length: 40 }, (_, i) => readBoard('key' + i, async () => { await gate; return { i }; }));
    expect(boardPendingSize()).toBeLessThanOrEqual(32);
    release();
    const rows = await Promise.all(reads);
    expect((rows[0] as any).i).toBe(0);
    expect((rows[39] as any).i).toBe(39);
    expect(boardPendingSize()).toBe(0);
  });
});

describe('board cache per-user isolation', () => {
  test("a warm cached page never serves one user's pending request id to another user", async () => {
    const leader = await makeUser('LeadX');
    const asker = await makeUser('AskX');
    const other = await makeUser('OtherX');
    const team = (await createTeam(leader.token, 'LeakCheck', { looking_for_members: true })).json().team;
    const jr = await app.inject({
      method: 'POST', url: `/api/teams/${team.id}/requests`,
      headers: { ...auth(asker.token), 'idempotency-key': idemKey() }, payload: {},
    });
    expect(jr.statusCode).toBe(201);
    const requestId = jr.json().request.id;

    // The asker's board shows their own pending request id (cold read, populates cache)
    const rb = await board(asker.token);
    const bRow = rb.json().teams.find((row: any) => row.id === team.id);
    expect(bRow.my_pending_request_id).toBe(requestId);

    // Another user with the SAME filters and the same cache key. Whether
    // this read hits the warm cache or re-fetches after a TTL lapse, the
    // isolation invariant must hold either way: their own (empty) pending
    // state, never the asker's request id. (Strict generated_at equality
    // would prove a cache hit but flakes when the two reads straddle the
    // 1s TTL; the existing warm-hit test owns that proof.)
    const rc = await board(other.token);
    const cRow = rc.json().teams.find((row: any) => row.id === team.id);
    expect(cRow.my_pending_request_id).toBeNull();
    expect(JSON.stringify(rc.json())).not.toContain(requestId);
    // And the cached payload itself must not carry any per-user state:
    // re-read as the ASKER and confirm their id still resolves for them.
    const rb2 = await board(asker.token);
    const bRow2 = rb2.json().teams.find((row: any) => row.id === team.id);
    expect(bRow2.my_pending_request_id).toBe(requestId);
  });
});
