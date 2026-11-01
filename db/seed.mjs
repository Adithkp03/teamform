// Seed script: 10,000 users and 2,000 teams with realistic distributions.
// Usage: DATABASE_URL=... node db/seed.mjs [users=10000] [teams=2000]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const N_USERS = Number(process.argv[2] || process.env.SEED_USERS || 10000);
const N_TEAMS = Number(process.argv[3] || process.env.SEED_TEAMS || 2000);

const SKILLS = ['react','node','typescript','python','postgres','mongodb','redis','docker','kubernetes','aws','gcp','graphql','nextjs','tailwind','rust','go','ml','data-engineering','devops','security','flutter','swift','figma','product'];
const TIMEZONES = [['Asia/Kolkata', 330], ['America/New_York', -300], ['America/Los_Angeles', -480], ['Europe/London', 0], ['Europe/Berlin', 60], ['Asia/Singapore', 480], ['Australia/Sydney', 660], ['America/Sao_Paulo', -180]];

function inviteCode() {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => A[b % 32]).join('');
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function sampleSkills() {
  const n = 2 + Math.floor(Math.random() * 4);
  const s = new Set();
  while (s.size < n) s.add(pick(SKILLS));
  return [...s];
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/teamform' });
await client.connect();
console.log('applying migrations...');
try {
  await client.query(readFileSync(join(here, 'migrations', '0001_init.sql'), 'utf8'));
} catch (e) {
  if (e.code !== '42P07') throw e; // tables already exist: fine for reseeding
  console.log('schema already present, continuing');
}

let { rows } = await client.query(`SELECT id FROM hackathons WHERE slug = 'ps1'`);
let hackathonId;
if (rows.length) hackathonId = rows[0].id;
else {
  ({ rows } = await client.query(
    `INSERT INTO hackathons (slug, name, team_size_min, team_size_max) VALUES ('ps1', 'Hack4Hack 2026', 2, 4) RETURNING id`));
  hackathonId = rows[0].id;
}
console.log('hackathon', hackathonId);

console.log(`seeding ${N_USERS} profiles...`);
const BATCH = 500;
const userIds = [];
for (let i = 0; i < N_USERS; i += BATCH) {
  const values = [], params = [];
  for (let j = 0; j < BATCH && i + j < N_USERS; j++) {
    const n = i + j;
    const id = crypto.randomUUID();
    userIds.push(id);
    const [tz, off] = pick(TIMEZONES);
    params.push(id, `Hacker ${n + 1}`, sampleSkills(), tz, off, Math.random() < 0.6);
    values.push(`($${params.length - 5}, $${params.length - 4}, $${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, true)`);
  }
  await client.query(
    `INSERT INTO profiles (id, display_name, skills, timezone, utc_offset_minutes, looking_for_team, is_seed) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
    params,
  );
  if ((i / BATCH) % 4 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, N_USERS)}/${N_USERS}`);
}
console.log();

console.log(`seeding ${N_TEAMS} teams...`);
const used = new Set();
for (let i = 0; i < N_TEAMS; i++) {
  const size = 1 + Math.floor(Math.random() * 4); // 1..4 members
  const members = [];
  while (members.length < Math.min(size, 4)) {
    const u = pick(userIds);
    if (!used.has(u)) { used.add(u); members.push(u); }
    if (used.size > N_USERS * 0.9) break;
  }
  if (!members.length) continue;
  const leader = members[0];
  const { rows: trows } = await client.query(
    `INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at, wanted_skills, looking_for_members)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', $5, $6) RETURNING id`,
    [hackathonId, `Team ${i + 1}`, leader, inviteCode(), sampleSkills(), Math.random() < 0.7],
  );
  const teamId = trows[0].id;
  for (let k = 0; k < members.length; k++) {
    await client.query(
      `INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [teamId, hackathonId, members[k], k === 0 ? 'leader' : 'member'],
    );
    await client.query(
      `INSERT INTO audit_log (hackathon_id, team_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4, $5)`,
      [hackathonId, teamId, members[k], k === 0 ? 'team_created' : 'member_joined', JSON.stringify(k === 0 ? { name: `Team ${i + 1}` } : { via: 'invite_code' })],
    );
  }
  if (i % 200 === 0) process.stdout.write(`\r  ${i}/${N_TEAMS}`);
}
console.log();

// Demo fixtures for walkthroughs, clearly separated from the 10,000 synthetic
// seed users: they are NOT counted in the seed totals and carry is_seed=false
// with a (demo) suffix so any report can filter them out.
for (const [name, skills] of [['Asha Verma (demo)', ['react', 'typescript', 'tailwind']], ['Rohan Iyer (demo)', ['node', 'postgres', 'redis']], ['Meera Nair (demo)', ['ml', 'python', 'data-engineering']]]) {
  await client.query(
    `INSERT INTO profiles (id, display_name, skills, timezone, utc_offset_minutes, looking_for_team, is_seed)
     VALUES ($1, $2, $3, 'Asia/Kolkata', 330, true, false) ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), name, skills],
  );
}

const counts = await client.query(`SELECT (SELECT count(*) FROM profiles) AS users, (SELECT count(*) FROM teams) AS teams, (SELECT count(*) FROM team_members) AS members`);
console.log('done:', counts.rows[0]);
await client.end();
