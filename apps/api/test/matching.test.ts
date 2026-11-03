import { describe, it, expect, beforeEach } from 'vitest';
import { app, resetDb, makeUser, auth } from './helpers';
import { pool } from '../src/db.js';

/** Suggestion scoring edge cases: timezone distance is circular on the 24h
 *  clock (UTC-12 vs UTC+14 are 2h apart, not 26h). */

async function looking(name: string, offset: number, tzName: string) {
  const u = await makeUser(name, ['react'], offset);
  await pool.query(`UPDATE profiles SET looking_for_team = true, timezone = $2 WHERE id = $1`, [u.id, tzName]);
  return u;
}

async function fit(meToken: string, candidateId: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/api/suggestions', headers: auth(meToken) });
  const s = res.json().suggestions.find((x: any) => x.id === candidateId);
  return s?.timezone_fit ?? -1;
}

describe('suggestions: circular timezone distance', () => {
  beforeEach(() => resetDb());

  it('UTC-12 vs UTC+14 are 2 clock hours apart (wraparound), not 26', async () => {
    const me = await looking('Me', -720, 'Etc/GMT+12'); // UTC-12
    const cand = await looking('Cand', 840, 'Pacific/Kiritimati'); // UTC+14
    expect(await fit(me.token, cand.id)).toBe(1);
  });

  it('same offset stays the strongest fit', async () => {
    const me = await looking('Me', 330, 'Asia/Calcutta');
    const cand = await looking('Cand', 330, 'Asia/Colombo');
    expect(await fit(me.token, cand.id)).toBe(2);
  });

  it('3 clock hours apart scores 0, even across the date line', async () => {
    const me = await looking('Me', -660, 'Etc/GMT+11'); // UTC-11
    const cand = await looking('Cand', 840, 'Pacific/Kiritimati'); // UTC+14: 25h -> 1h? no: 25 mod 24 = 1h
    // UTC-11 vs UTC+14: raw diff 1500m = 25h -> clock distance 1h -> fit 1
    expect(await fit(me.token, cand.id)).toBe(1);
    const me2 = await looking('Me2', -600, 'Etc/GMT+10'); // UTC-10 vs UTC+14: 24h -> same clock time
    expect(await fit(me2.token, cand.id)).toBe(2);
  });
});

describe('suggestions: live IANA offsets (DST-safe)', () => {
  beforeEach(() => resetDb());

  it('a stale stored offset does not skew scoring - the IANA name wins', async () => {
    // Me: Asia/Kolkata, but the stored offset drifted to 0 (as after a DST
    // change with no profile re-save). Candidate: Europe/London, stored 0.
    // Live offsets are 330 vs 0 (winter) - 5.5h apart, never within 2h.
    const me = await looking('Me', 330, 'Asia/Kolkata');
    await pool.query(`UPDATE profiles SET utc_offset_minutes = 0 WHERE id = $1`, [me.id]);
    const cand = await looking('Cand', 0, 'Europe/London');
    expect(await fit(me.token, cand.id)).toBe(0);
  });

  it('free-form zone names fall back to the saved offset', async () => {
    const me = await looking('Me', 330, 'Asia/Calcutta');
    const cand = await looking('Cand', 330, 'Mars/Olympus');
    expect(await fit(me.token, cand.id)).toBe(2);
  });
});
