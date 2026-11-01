// Load test for the board endpoint: the read every participant hammers.
// Target: p95 < 200 ms with 100 concurrent users.
import http from 'k6/http';
import { check } from 'k6';

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
const TOKEN = __ENV.TOKEN;

export default function () {
  const res = http.get(`${BASE}/api/board`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    tags: { name: 'GET /api/board' },
  });
  check(res, { 'board 200': (r) => r.status === 200 });
}
