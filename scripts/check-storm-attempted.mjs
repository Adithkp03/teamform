// Guard against a vacuous chaos pass: read the storm log and require real
// join attempts to have reached the API (ok or expected-conflict outcomes).
import { readFileSync } from 'node:fs';
const log = readFileSync('/tmp/chaos-storm.log', 'utf8');
const m = log.match(/ok=(\d+) expected-conflicts=(\d+) transport-failures=(\d+)/);
const ok = Number(m?.[1] ?? 0), conflicts = Number(m?.[2] ?? 0);
if (!m || ok + conflicts === 0) {
  console.error(`FAIL: storm attempted nothing (ok=${ok}, conflicts=${conflicts}) - the API was never exercised`);
  process.exit(1);
}
console.log(`PASS: storm reached the API (ok=${ok}, expected-conflicts=${conflicts})`);
