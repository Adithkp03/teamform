// Post-chaos invariant checker. Exits non-zero if ANY invariant is violated.
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/teamform' });
await client.connect();

const checks = [
  ['no team exceeds its hackathon max size', `
    SELECT count(*)::int AS violations FROM (
      SELECT t.id FROM teams t JOIN hackathons h ON h.id = t.hackathon_id
      JOIN team_members tm ON tm.team_id = t.id
      GROUP BY t.id, h.team_size_max HAVING count(*) > h.team_size_max
    ) x`],
  ['no person is in two teams in one hackathon', `
    SELECT count(*)::int AS violations FROM (
      SELECT hackathon_id, user_id FROM team_members GROUP BY 1, 2 HAVING count(*) > 1
    ) x`],
  ['every team leader is actually a member with role leader', `
    SELECT count(*)::int AS violations FROM teams t
    WHERE NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = t.leader_id AND tm.role = 'leader')`],
  ['no accepted request lacks a membership', `
    SELECT count(*)::int AS violations FROM join_requests jr
    WHERE jr.status = 'accepted' AND NOT EXISTS (
      SELECT 1 FROM team_members tm WHERE tm.team_id = jr.team_id AND tm.user_id = jr.user_id)`],
  ['no pending request belongs to someone already in a team for that hackathon', `
    SELECT count(*)::int AS violations FROM join_requests jr
    WHERE jr.status = 'pending' AND EXISTS (
      SELECT 1 FROM team_members tm WHERE tm.hackathon_id = jr.hackathon_id AND tm.user_id = jr.user_id)`],
  ['every membership has a matching audit entry', `
    SELECT count(*)::int AS violations FROM team_members tm
    WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.team_id = tm.team_id AND a.metadata->>'via' IS NOT NULL
      AND (a.metadata->>'user_id' = tm.user_id::text OR a.actor_id = tm.user_id))`],
];

let failed = 0;
for (const [name, sql] of checks) {
  const { rows } = await client.query(sql);
  const n = rows[0].violations ?? rows[0].count;
  console.log(`${n === 0 ? 'PASS' : 'FAIL'} (${n}) ${name}`);
  if (n !== 0) failed++;
}
await client.end();
process.exit(failed ? 1 : 0);
