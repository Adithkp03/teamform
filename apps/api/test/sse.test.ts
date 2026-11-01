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

describe('SSE poll mode cursor reliability (production mode)', () => {
  test('reconnect with Last-Event-ID replays missed events without a sync', async () => {
    const u = await makeUser('CursorUser');
    // Connect and receive one real change event to learn a cursor.
    const ctrl1 = new AbortController();
    const res1 = await fetch(`${base}/api/events`, { signal: ctrl1.signal, headers: { authorization: `Bearer ${u.token}` } });
    const reader1 = res1.body!.getReader();
    const dec = new TextDecoder();
    let buf1 = '';
    await new Promise((r) => setTimeout(r, 300));
    await createTeam(u.token, 'Cursor Team One');
    const deadline1 = Date.now() + 5000;
    while (Date.now() < deadline1 && !buf1.replace(/ /g, '').includes('"t":"teams"')) {
      const { done, value } = await reader1.read();
      if (done) break;
      buf1 += dec.decode(value ?? new Uint8Array(), { stream: true });
    }
    ctrl1.abort();
    const ids1 = [...buf1.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]);
    const lastId = ids1[ids1.length - 1];
    expect(lastId).toBeTruthy();

    // A second change commits while the client is disconnected (another
    // user creates it: one team per user per hackathon).
    const other = await makeUser('CursorOther');
    const second = await createTeam(other.token, 'Cursor Team Two');
    expect(second.statusCode).toBe(201);

    // Reconnect with the cursor: the missed event is REPLAYED (no sync
    // fallback), with a higher cursor id.
    const buf2 = await (async () => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/api/events`, {
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${u.token}`, 'last-event-id': lastId! },
      });
      const reader = res.body!.getReader();
      let out = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value ?? new Uint8Array(), { stream: true });
        const ids = [...out.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
        if (ids.some((n) => n > Number(lastId)) && out.replace(/ /g, '').includes('"t":"teams"')) break;
      }
      ctrl.abort();
      return out;
    })();
    expect(buf2).not.toContain('event: sync');
    expect(buf2.replace(/ /g, '')).toContain('"t":"teams"');
    const ids2 = [...buf2.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(Math.max(...ids2)).toBeGreaterThan(Number(lastId));
  }, 12_000);

  test('concurrent writers produce a contiguous, no-skip event sequence to a connected client', async () => {
    const u = await makeUser('StormUser');
    const collected: number[] = [];
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal, headers: { authorization: `Bearer ${u.token}` } });
    const reading = (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && collected.length < 30) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value ?? new Uint8Array(), { stream: true });
        for (const m of buf.matchAll(/^id: (\d+)$/gm)) {
          const n = Number(m[1]);
          if (!collected.includes(n)) collected.push(n);
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 400));
    // 10 concurrent writers (10 users - one team per user per hackathon):
    // commit order vs insert-id order is deliberately racy.
    const writers = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(`StormW${i}`)));
    await Promise.all(writers.map((w, i) => createTeam(w.token, `Storm ${i}`)));
    await reading.catch(() => {});
    ctrl.abort();
    collected.sort((a, b) => a - b);
    // Semantic, not brittle-count: each create emits teams-INSERT +
    // team_members-INSERT + teams-UPDATE(member_count) = 3 events today, but
    // what matters is complete ordered delivery - every committed event
    // between the first and last seen must arrive, with at least the
    // essential 2 per created team present.
    expect(collected.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < collected.length; i++) {
      // Gapless: no committed event was skipped between the first and last seen.
      expect(collected[i] - collected[i - 1]).toBe(1);
    }
  }, 12_000);

  test('member join emits a teams UPDATE event (board-visible member_count invalidation)', async () => {
    const leader = await makeUser('CntLeader');
    const team = (await createTeam(leader.token, 'CntTeam')).json().team;
    const watcher = await makeUser('CntWatcher');
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal, headers: { authorization: `Bearer ${watcher.token}` } });
    const reading = (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value ?? new Uint8Array(), { stream: true });
        if (buf.replace(/ /g, '').includes('"t":"teams","op":"UPDATE"')) break;
      }
      return buf;
    })();
    await new Promise((r) => setTimeout(r, 400));
    const joiner = await makeUser('CntJoiner');
    const join = await app.inject({
      method: 'POST', url: '/api/teams/join-by-code',
      headers: { ...auth(joiner.token), 'idempotency-key': idemKey() },
      payload: { code: team.invite_code },
    });
    expect(join.statusCode).toBe(201);
    const buf = await reading.catch(() => '');
    ctrl.abort();
    // Board clients watching a team card must see the count change.
    expect(buf.replace(/ /g, '')).toContain('"t":"teams","op":"UPDATE"');
    expect(buf.replace(/ /g, '')).toContain('"t":"team_members","op":"INSERT"');
  }, 12_000);
});
