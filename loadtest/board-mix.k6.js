// Mixed workload: 99 concurrent board readers + 4 mutator VUs (103 VUs
// total; the PS hot-read run with 100 board readers is board.k6.js, run
// separately). The mutators continuously create, join, and leave teams.
// This exercises the board cache beyond the hot read path: every mutation
// invalidates the same-instance cache, so reader traffic is a real warm/
// cold mix, and the field-level read-your-write checks below compare the
// actual board fields (team id, member_count) after create/join/leave -
// not just 200 statuses.
// Target: p95 < 200 ms on reads WITH mutations in flight; no 5xx anywhere.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

export const options = {
  scenarios: {
    readers: {
      executor: 'constant-vus',
      vus: 99,
      duration: '60s',
      exec: 'readBoard',
    },
    mutator: {
      executor: 'constant-vus',
      // 4 mutator pairs = 8 signups, under the 10/min per-IP signup limit.
      // Each VU paces below its 5 creates/min per-user rate limit, so the
      // mutation stream operates within the app's declared limits and any
      // failure is a real failure, not a 429 the app intentionally sent.
      vus: 4,
      duration: '60s',
      exec: 'mutate',
    },
  },
  thresholds: {
    'http_req_duration{name:GET /api/board}': ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
    'http_req_failed{expected_response:true}': ['rate<0.01'],
  },
};

const BASE = __ENV.BASE_URL;

function signup(tag) {
  const email = `mix-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@load.test`;
  const res = http.post(
    `${BASE}/api/auth/signup`,
    JSON.stringify({ email, password: 'load-test-pass-1', display_name: `Mix ${tag}` }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (res.status !== 201 && res.status !== 200) fail(`signup ${tag} failed: ${res.status} ${res.body}`);
  return res.json('token');
}

export function setup() {
  const pairs = [];
  for (let i = 0; i < 4; i++) pairs.push({ leader: signup(`l${i}`), joiner: signup(`j${i}`) });
  return { reader: pairs[0].leader, pairs };
}

// Scenario VU numbering: readers take 1-99, mutators take 100-103. Each
// mutator VU pins itself to one pair so concurrent VUs never share users.
const PAIR_IDX = __VU >= 100 ? (__VU - 100) % 4 : 0;

// Log the first mutation failure per VU (status + body) so the CI job log
// records the failure class instead of a bare check count.
let failureLogged = false;
const logFailure = (what, r) => {
  if (failureLogged) return;
  failureLogged = true;
  console.log(`mutator VU ${__VU}: ${what} failed: status=${r.status} body=${String(r.body).slice(0, 200)}`);
};

const bearer = (t) => ({ authorization: `Bearer ${t}` });
const json = (t) => ({ ...bearer(t), 'content-type': 'application/json' });

export function readBoard(data) {
  const res = http.get(`${BASE}/api/board`, {
    headers: bearer(data.reader),
    tags: { name: 'GET /api/board' },
  });
  check(res, {
    'board 200': (r) => r.status === 200,
    'board has arrays': (r) => Array.isArray(r.json('teams')) && Array.isArray(r.json('people')),
  });
}

export function mutate(data) {
  data = { leader: data.pairs[PAIR_IDX].leader, joiner: data.pairs[PAIR_IDX].joiner };
  // create (leader) -> read-your-write on the board -> joiner joins -> joiner
  // leaves -> leader leaves (team deleted). Every step invalidates the cache.
  const created = http.post(
    `${BASE}/api/teams`,
    JSON.stringify({ name: `Mix ${Date.now()}`, looking_for_members: true, wanted_skills: ['k6'] }),
    { headers: { ...json(data.leader), 'idempotency-key': `mix-${__VU}-${__ITER}` }, tags: { name: 'POST /api/teams' } },
  );
  // Pace failures too: an early return without sleep hot-loops retries
  // inside the same fixed rate-limit window, which is how one transient
  // failure used to turn into thousands of expected 429s (run #20).
  if (!check(created, { 'create 201': (r) => r.status === 201 })) {
    logFailure('create', created);
    sleep(15);
    return;
  }
  const team = created.json('team');

  // Field-level read-your-write: the created team appears with its actual
  // fields (same instance -> post-commit invalidation -> immediate).
  const findOnBoard = (r, id) => (r.json('teams') || []).find((t) => t.id === id);
  const board = http.get(`${BASE}/api/board`, { headers: bearer(data.leader), tags: { name: 'GET /api/board' } });
  check(board, {
    'ryw create: team on board with member_count 1': (r) => {
      const t = r.status === 200 && findOnBoard(r, team.id);
      return !!t && t.name === team.name && t.member_count === 1;
    },
  });

  const joined = http.post(
    `${BASE}/api/teams/join-by-code`,
    JSON.stringify({ code: team.invite_code }),
    { headers: { ...json(data.joiner), 'idempotency-key': `mixj-${__VU}-${__ITER}` }, tags: { name: 'POST /join-by-code' } },
  );
  if (!check(joined, { 'join 201': (r) => r.status === 201 })) {
    logFailure('join', joined);
    // Cleanup so the leader is not stuck already_in_team on the next cycle.
    http.post(`${BASE}/api/teams/${team.id}/leave`, null, { headers: bearer(data.leader), tags: { name: 'POST /leave' } });
    sleep(15);
    return;
  }

  const board2 = http.get(`${BASE}/api/board`, { headers: bearer(data.leader), tags: { name: 'GET /api/board' } });
  check(board2, {
    'ryw join: member_count 2': (r) => {
      const t = r.status === 200 && findOnBoard(r, team.id);
      return !!t && t.member_count === 2;
    },
  });

  const leaveJ = http.post(`${BASE}/api/teams/${team.id}/leave`, null, { headers: bearer(data.joiner), tags: { name: 'POST /leave' } });
  if (!check(leaveJ, { 'joiner leave 200': (r) => r.status === 200 })) {
    logFailure('joiner leave', leaveJ);
    http.post(`${BASE}/api/teams/${team.id}/leave`, null, { headers: bearer(data.leader), tags: { name: 'POST /leave' } });
    sleep(15);
    return;
  }

  const board3 = http.get(`${BASE}/api/board`, { headers: bearer(data.leader), tags: { name: 'GET /api/board' } });
  check(board3, {
    'ryw leave: member_count 1': (r) => {
      const t = r.status === 200 && findOnBoard(r, team.id);
      return !!t && t.member_count === 1;
    },
  });

  const leaveL = http.post(`${BASE}/api/teams/${team.id}/leave`, null, { headers: bearer(data.leader), tags: { name: 'POST /leave' } });
  check(leaveL, { 'leader leave 200': (r) => r.status === 200 });

  // ~17s hosted cycle => ~3.5 creates/min per user, below the 5/min limit
  // with margin for fixed-window boundary drift.
  sleep(15);
}
