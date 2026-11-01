import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { app, migrate, resetDb, makeUser, auth, idemKey, createTeam } from './helpers.js';

/**
 * SSE tests run against a real listening server (inject cannot stream).
 * The server, the test client, and the API pool share one Postgres, so
 * LISTEN/NOTIFY round-trips are exercised end to end.
 */
let base = '';
beforeAll(async () => {
  migrate();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await app.close(); });
beforeEach(() => resetDb());

/** Read the stream until predicate matches or timeout; returns collected text. */
async function readUntil(url: string, match: (s: string) => boolean, ms = 4000, token?: string): Promise<string> {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: boolean; value?: Uint8Array }>((r) => setTimeout(() => r({ done: false }), Math.max(1, deadline - Date.now()))),
    ]);
    if (done) break;
    if (value) buf += dec.decode(value, { stream: true });
    if (match(buf)) break;
  }
  ctrl.abort();
  return buf;
}

describe('SSE /api/events', () => {
  test('missing or invalid Authorization header is rejected with 401, no stream opens', async () => {
    const noToken = await fetch(`${base}/api/events`);
    expect(noToken.status).toBe(401);
    const badToken = await fetch(`${base}/api/events`, { headers: { authorization: 'Bearer forged-token-value' } });
    expect(badToken.status).toBe(401);
    // Token must not travel in the URL: a query-token-only request is rejected.
    const queryOnly = await fetch(`${base}/api/events?token=forged-token-value`);
    expect(queryOnly.status).toBe(401);
  });

  test('connect sends an initial sync event (reconnect resync covers missed events)', async () => {
    const u = await makeUser('SSE1');
    const buf = await readUntil(`${base}/api/events`, (s) => s.includes('event: sync'), 4000, u.token);
    expect(buf).toContain('event: sync');
  });

  test('a board mutation pushes a change event to a connected client', async () => {
    const u = await makeUser('SSE2');
    const collected = readUntil(
      `${base}/api/events`,
      (s) => s.includes('event: change') && s.replace(/ /g, '').includes('"t":"teams"'),
      4000, u.token,
    );
    // Wait for the stream to be established, then mutate.
    await new Promise((r) => setTimeout(r, 500));
    const res = await createTeam(u.token, 'SSE Team');
    expect(res.statusCode).toBe(201);
    const buf = await collected;
    expect(buf).toContain('event: change');
    expect(buf.replace(/ /g, '')).toContain('"t":"teams"');
  });

  test('join_request changes reach only the team leader, not other users', async () => {
    const leader = await makeUser('LeaderSSE');
    const outsider = await makeUser('OutsiderSSE');
    const joiner = await makeUser('JoinerSSE');
    const team = await createTeam(leader.token, 'Private Signals');
    const teamId = team.json().team.id;

    // Outsider listens; leader listens.
    const outsiderBuf = readUntil(`${base}/api/events`, (s) => s.includes('"t":"join_requests"'.replace(/ /g, '')), 2500, outsider.token);
    const leaderBuf = readUntil(`${base}/api/events`, (s) => s.replace(/ /g, '').includes('"t":"join_requests"'), 4000, leader.token);
    await new Promise((r) => setTimeout(r, 500));
    const res = await app.inject({
      method: 'POST', url: `/api/teams/${teamId}/requests`,
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() }, payload: { message: 'please add me' },
    });
    expect(res.statusCode).toBe(201);
    const seenByLeader = await leaderBuf;
    expect(seenByLeader.replace(/ /g, '')).toContain('"t":"join_requests"');
    // The private message never travels inside event payloads.
    expect(seenByLeader).not.toContain('please add me');
    const seenByOutsider = await outsiderBuf;
    expect(seenByOutsider).not.toContain('join_requests');
  });

  test('reconnect after a missed change gets a fresh sync event', async () => {
    const u = await makeUser('SSE3');
    // First connection, then drop it.
    const first = await readUntil(`${base}/api/events`, (s) => s.includes('event: sync'), 4000, u.token);
    expect(first).toContain('event: sync');
    // Change happens while disconnected.
    await createTeam(u.token, 'Made While Away');
    // Reconnect: server sends sync again, prompting the client to refetch state.
    const second = await readUntil(`${base}/api/events`, (s) => s.includes('event: sync'), 4000, u.token);
    expect(second).toContain('event: sync');
    // And the refetched board really contains the missed change.
    const board = await app.inject({ method: 'GET', url: '/api/board', headers: auth(u.token) });
    expect(JSON.stringify(board.json())).toContain('Made While Away');
  });
}, 15_000);
