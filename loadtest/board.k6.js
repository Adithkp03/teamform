// Load test for the board endpoint: the read every participant hammers.
// Target: p95 < 200 ms with 100 concurrent users.
// Auth: signs up its own throwaway user in setup() - never the dev-login
// endpoint, so this works against production (ALLOW_DEV_LOGIN=false).
import http from 'k6/http';
import { check, fail } from 'k6';

export const options = {
  scenarios: {
    board: {
      executor: 'constant-vus',
      vus: 100,
      duration: '60s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE = __ENV.BASE_URL;

export function setup() {
  const email = `loadtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@load.test`;
  const res = http.post(
    `${BASE}/api/auth/signup`,
    JSON.stringify({ email, password: 'load-test-pass-1', display_name: 'Load Test' }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (res.status !== 201 && res.status !== 200) {
    fail(`signup for load user failed: ${res.status} ${res.body}`);
  }
  return { token: res.json('token') };
}

export default function (data) {
  const res = http.get(`${BASE}/api/board`, {
    headers: { authorization: `Bearer ${data.token}` },
    tags: { name: 'GET /api/board' },
  });
  check(res, { 'board 200': (r) => r.status === 200 });
}
