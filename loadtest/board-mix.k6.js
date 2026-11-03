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
import { Counter } from 'k6/metrics';

export const options = {
  // p50 comes out as `med`; p99 requires opting into the extended trend stats.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    readers: {
      executor: 'constant-vus',
      vus: 99,
      duration: '60s',
      exec: 'readBoard',
    },
    mutator: {
      executor: 'constant-vus',
      // Each mutator VU signs up its own leader+joiner pair on its first
      // iteration (8 signups total + 1 reader = 9, under the 10/min per-IP
      // signup limit) and paces below its 5 creates/min per-user limit, so
      // the mutation stream operates within the app's declared limits and
      // any failure is a real failure, not a 429 the app intentionally sent.
      vus: 4,
      duration: '60s',
      exec: 'mutate',
    },
  },
  thresholds: {
    'http_req_duration{name:GET /api/board}': ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
    'http_req_failed{expected_response:true}': ['rate<0.01'],
    // Vacuous-pass guard: the read-your-write checks only execute on the
    // success path, so a run where every create fails would show zero
    // failing checks. Require at least 12 full create->join->leave cycles
    // (4 VUs x ~3.5/min each) or the run fails even with a clean board p95.
    mix_full_cycles: ['count>=12'],
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
  return { reader: signup('reader') };
}

// Log the first mutation failure per VU (status + body) so the CI job log
// records the failure class instead of a bare check count.
const fullCycles = new Counter('mix_full_cycles');

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

// Team the joiner may still be inside after a failed joiner-leave (the
// script knows the id because the joiner only ever joins this VU's own
// team). Cleared by the unstick retry at the top of the next cycle, so a
// transient failure can never orphan a transferred-leadership team across
// iterations.
let stuckIn = null;

// Per-VU pair, created lazily on the first iteration. k6 does NOT assign
// scenario VU ids in scenario order (observed: mutators got __VU 40-43
// while readers took the rest), so pinning pairs by __VU range collided:
// four mutator VUs shared one leader and every concurrent create failed
// 409 already_in_team - the initial failure class behind run #20's mix
// failure, reproduced locally with logged status/body. Lazy per-VU signup
// removes the assumption entirely: concurrent VUs can never share users.
let myPair = null;

export function mutate(data) {
  if (!myPair) myPair = { leader: signup(`l${__VU}`), joiner: signup(`j${__VU}`) };
  data = myPair;
  if (stuckIn) {
    const unstick = http.post(`${BASE}/api/teams/${stuckIn}/leave`, null, { headers: bearer(data.joiner), tags: { name: 'POST /leave' } });
    if (unstick.status === 200 || unstick.status === 409) stuckIn = null;
    else logFailure('unstick joiner leave', unstick);
  }
  // create (leader) -> read-your-write on the board -> joiner joins -> joiner
  // leaves -> leader leaves (team deleted). Every step invalidates the cache.
  const created = http.post(
    `${BASE}/api/teams`,
    JSON.stringify({ name: `Mix ${Date.now()}`, looking_for_members: true, wanted_skills: ['k6'] }),
    { headers: { ...json(data.leader), 'idempotency-key': `mix-${String(__VU).padStart(3, '0')}-${String(__ITER).padStart(3, '0')}` }, tags: { name: 'POST /api/teams' } },
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
    { headers: { ...json(data.joiner), 'idempotency-key': `mixj-${String(__VU).padStart(3, '0')}-${String(__ITER).padStart(3, '0')}` }, tags: { name: 'POST /join-by-code' } },
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
    // Leader leaves (leadership transfers to the joiner); the joiner leaves
    // the orphan via the stuckIn retry at the top of the next cycle, which
    // deletes it (last member). No orphaned team survives the run.
    stuckIn = team.id;
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
  if (check(leaveL, { 'leader leave 200': (r) => r.status === 200 })) fullCycles.add(1);

  // ~17s hosted cycle => ~3.5 creates/min per user, below the 5/min limit
  // with margin for fixed-window boundary drift.
  sleep(15);
}
