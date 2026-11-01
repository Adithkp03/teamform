# Load test

`board.k6.js` hammers the board endpoint - the read every participant hits.

- 100 concurrent VUs, 60s, thresholds: p95 < 200ms, error rate < 1%.
- Auth: the script signs up its own throwaway user in `setup()` (never the
  dev-login endpoint), so it runs against production with
  `ALLOW_DEV_LOGIN=false`.

## Run

```sh
# local
k6 run -e BASE_URL=http://localhost:3000 loadtest/board.k6.js

# deployed (report saves raw output alongside)
k6 run -e BASE_URL=https://teamform-api.vercel.app loadtest/board.k6.js | tee loadtest/deployed-$(date +%Y%m%d).txt
```

Cold-start is measured and reported separately from warm numbers: Neon free
scales to zero after 5 min idle and Vercel functions cold-start, so the first
requests after idle are expected to be slower. Honest reporting distinguishes
warm p95 (the PS target) from cold p95 (first hit after idle).
