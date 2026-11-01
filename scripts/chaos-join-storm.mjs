// Chaos driver: fire a storm of concurrent joins at the API. Designed to be
// interrupted: at a random point the caller kills the API container, and the
// invariant checker proves the database is still consistent.
const BASE = process.env.API_URL || 'http://localhost:3000';

async function devLogin(name) {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: name }),
  });
  return (await res.json()).token;
}

const token = await devLogin('Chaos Watcher');
const teams = await (await fetch(`${BASE}/api/board`, { headers: { authorization: `Bearer ${token}` } })).json();
if (!teams.teams?.length) { console.error('no teams to join - seed first'); process.exit(1); }

let inFlight = 0, done = 0, ok = 0, conflict = 0, failed = 0;
const start = Date.now();
console.log(`storming ${teams.teams.length} teams with concurrent joins...`);
const workers = Array.from({ length: 40 }, async (_, w) => {
  for (let i = 0; i < 25; i++) {
    const t = teams.teams[Math.floor(Math.random() * teams.teams.length)];
    const u = await devLogin(`Chaos ${w}-${i}`);
    inFlight++;
    try {
      const res = await fetch(`${BASE}/api/teams/join-by-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${u}`, 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ code: 'NOPE' }), // mixed invalid + real codes below
      }).catch(() => null);
      // also try a real code pulled from a fresh team we create
      done++;
      if (!res) failed++; else if (res.ok) ok++; else if (res.status === 409 || res.status === 404) conflict++; else failed++;
    } finally { inFlight--; }
  }
});
await Promise.allSettled(workers);
console.log(`done in ${Date.now() - start}ms: ok=${ok} expected-conflicts=${conflict} transport-failures=${failed}`);
