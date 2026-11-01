// Set-based seed for managed (high-latency) Postgres: a handful of round trips
// instead of ~8,000 serial inserts. Produces exactly 2,000 teams on top of the
// 10,000 seed profiles from db/seed.mjs, with the same invariants (leader is a
// member with role 'leader', no user in two teams, audit rows for creation).
// Idempotent within an empty teams table: run after TRUNCATE or on a fresh DB.
import pg from 'pg';

const url = process.env.DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
await client.connect();

// Seed profiles are synthetic (no auth account, no password_hash): they can
// never log in. Create them set-based if absent so this script is the single
// clean-database path.
const { rows: users } = await client.query('SELECT count(*)::int AS n FROM profiles WHERE is_seed');
if (users[0].n === 0) {
  await client.query(
    `INSERT INTO profiles (id, display_name, skills, timezone, utc_offset_minutes, looking_for_team, is_seed)
     SELECT gen_random_uuid(),
            'Seed User ' || g,
            (ARRAY['react','typescript','node','postgres','python','ml','go','rust','design','devops'])[1 + (g % 10): 1 + (g % 10) + (g % 2)],
            'Asia/Kolkata', 330, (g % 10) < 6, true
     FROM generate_series(1, 10000) AS g`, []);
}
console.log('seed profiles:', (await client.query('SELECT count(*) FROM profiles WHERE is_seed')).rows[0].count);

let hackathonId;
const { rows: hex } = await client.query(`SELECT id FROM hackathons WHERE slug = 'ps1' LIMIT 1`);
if (hex.length) { hackathonId = hex[0].id; } else {
  const { rows: h } = await client.query(
    `INSERT INTO hackathons (slug, name, team_size_min, team_size_max) VALUES ('ps1', 'Hack4Hack 2026', 2, 4) RETURNING id`);
  hackathonId = h[0].id;
}
console.log('hackathon', hackathonId);

const { rows: existing } = await client.query('SELECT count(*)::int AS n FROM teams');
if (existing[0].n === 0) await client.query(
  `WITH leaders AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM profiles WHERE is_seed ORDER BY id LIMIT 2000)
   INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at, wanted_skills, looking_for_members)
   SELECT $1, 'Team ' || rn, id,
          upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
          now() + interval '7 days',
          CASE rn % 3 WHEN 0 THEN ARRAY['react','typescript'] WHEN 1 THEN ARRAY['node','postgres'] ELSE ARRAY['python','ml'] END,
          rn % 10 < 7
   FROM leaders`, [hackathonId]);
console.log('teams:', (await client.query('SELECT count(*) FROM teams')).rows[0].count);

const { rows: mc } = await client.query('SELECT count(*)::int AS n FROM team_members');
if (mc[0].n === 0) {
  await client.query(
    `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
     SELECT id, $1, leader_id, 'leader' FROM teams ON CONFLICT DO NOTHING`, [hackathonId]);
  await client.query(
    `WITH t AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM teams),
          extra AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM profiles WHERE is_seed AND id NOT IN (SELECT leader_id FROM teams))
     INSERT INTO team_members (team_id, hackathon_id, user_id, role)
     SELECT t.id, $1, e.id, 'member' FROM t JOIN extra e ON e.rn > (t.rn - 1) * 2 AND e.rn <= t.rn * 2
     ON CONFLICT DO NOTHING`, [hackathonId]);
}
console.log('members:', (await client.query('SELECT count(*) FROM team_members')).rows[0].count);

const { rows: ac } = await client.query('SELECT count(*)::int AS n FROM audit_log');
if (ac[0].n === 0) {
  await client.query(
    `INSERT INTO audit_log (hackathon_id, team_id, actor_id, action, metadata)
     SELECT $1, id, leader_id, 'team_created', json_build_object('name', name) FROM teams`, [hackathonId]);
  await client.query(
    `INSERT INTO audit_log (hackathon_id, team_id, actor_id, action, metadata)
     SELECT hackathon_id, team_id, user_id, 'member_joined', json_build_object('via', 'invite_code')
     FROM team_members WHERE role = 'member'`, []);
}
console.log('audit:', (await client.query('SELECT count(*) FROM audit_log')).rows[0].count);

for (const [name, skills] of [['Asha Verma (demo)', ['react', 'typescript', 'tailwind']], ['Rohan Iyer (demo)', ['node', 'postgres', 'redis']], ['Meera Nair (demo)', ['ml', 'python', 'data-engineering']]]) {
  await client.query(
    `INSERT INTO profiles (id, display_name, skills, timezone, utc_offset_minutes, looking_for_team, is_seed)
     VALUES ($1, $2, $3, 'Asia/Kolkata', 330, true, false) ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), name, skills]);
}
const counts = await client.query(`SELECT (SELECT count(*) FROM profiles) AS users, (SELECT count(*) FROM teams) AS teams, (SELECT count(*) FROM team_members) AS members`);
console.log('done:', counts.rows[0]);
await client.end();
