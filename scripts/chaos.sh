#!/usr/bin/env bash
# Chaos test: kill the API mid-join-storm and prove the database is not corrupted.
# Usage: bash scripts/chaos.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/teamform}

echo "== starting stack =="
# On any startup failure, dump the actual container state and logs - a green
# checkmark without the containers' own output is not evidence.
if ! docker compose up -d --build --wait db api; then
  echo "== stack failed to become healthy: container state =="
  docker compose ps -a || true
  echo "== api container logs =="
  docker compose logs api || true
  echo "== db container logs =="
  docker compose logs db | tail -30 || true
  exit 1
fi

echo "== seeding (small: 300 users, 80 teams) =="
docker compose exec -T db psql -U postgres -d teamform -c 'SELECT 1' >/dev/null
DATABASE_URL=postgres://postgres:postgres@localhost:5432/teamform node db/seed.mjs 300 80

echo "== starting join storm in background =="
API_URL=http://localhost:3000 node scripts/chaos-join-storm.mjs | tee /tmp/chaos-storm.log &
STORM_PID=$!
sleep 2

echo "== KILLING the API mid-storm =="
docker compose kill api
sleep 1

echo "== restarting API =="
if ! docker compose up -d --wait api; then
  echo "== api failed to restart: container logs =="
  docker compose logs api || true
  exit 1
fi
wait $STORM_PID || true

# Vacuous-pass guard: the storm must have actually attempted joins against the
# API before the kill. Without this, a dead stack "passes" the invariant
# checks on an untouched database.
echo "== storm evidence =="
grep -E 'storming|done in' /tmp/chaos-storm.log || true
node scripts/check-storm-attempted.mjs

echo "== checking invariants =="
node scripts/check-invariants.mjs
echo "== chaos test PASSED =="
