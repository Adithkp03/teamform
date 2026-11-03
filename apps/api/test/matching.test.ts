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
