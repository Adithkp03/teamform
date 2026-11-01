// Chaos driver: generate REAL concurrent join traffic (fresh teams with real
// invite codes, racers fighting for seats, mixed with invalid codes) while
// the caller kills the API at a random point. Afterwards
// scripts/check-invariants.mjs proves the database is still consistent.
const BASE = process.env.API_URL || 'http://localhost:3000';

async function devLogin(name) {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: name }),
  }).catch(() => null);
  if (!res || !res.ok) return null; // API down mid-storm: caller counts it
  return (await res.json()).token;
}

const post = (url, token, body, key) =>
  fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key ?? crypto.randomUUID() },
    body: JSON.stringify(body),
  }).catch(() => null);

let done = 0, ok = 0, conflict = 0, failed = 0;
const start = Date.now();
const WORKERS = Number(process.env.CHAOS_WORKERS || 20);
const JOINS = Number(process.env.CHAOS_JOINS || 40);
console.log(`storming: ${WORKERS} workers x (1 team + ${JOINS} real join attempts)`);

const workers = Array.from({ length: WORKERS }, async (_, w) => {
  const leader = await devLogin(`Chaos Leader ${w}`);
  if (!leader) { failed += JOINS; return; }
  const mk = await post('/api/teams', leader, { name: `Chaos ${w}` });
  if (!mk || !mk.ok) { failed += JOINS; return; }
  const code = (await mk.json()).team.invite_code;
  for (let i = 0; i < JOINS; i++) {
    const u = await devLogin(`Chaos ${w}-${i}`);
    if (!u) { failed += JOINS - i; return; } // API killed: remaining attempts lost
    // mostly real codes (seat races -> real writes), some invalid on purpose
    const useCode = i % 7 === 3 ? 'NOPE' : code;
    const res = await post('/api/teams/join-by-code', u, { code: useCode });
    done++;
    if (!res) failed++;
    else if (res.ok) ok++;
    else if (res.status === 409 || res.status === 404 || res.status === 410 || res.status === 429) conflict++;
    else failed++;
  }
});
await Promise.allSettled(workers);
console.log(`done in ${Date.now() - start}ms: ok=${ok} expected-conflicts=${conflict} transport-failures=${failed}`);
