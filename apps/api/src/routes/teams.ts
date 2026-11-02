import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx, type TxClient } from '../db.js';
import { authenticate } from '../auth.js';
import { parse, genInviteCode } from '../util.js';
import { errors } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { respond } from '../respond.js';
import { rateLimit } from '../ratelimit.js';

const uuidParam = z.string().uuid();
const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(80),
  wanted_skills: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  looking_for_members: z.boolean().default(true),
});

const joinByCodeSchema = z.object({ code: z.string().trim().min(1).max(32) });
const joinRequestSchema = z.object({ message: z.string().trim().max(500).optional() });

async function audit(client: TxClient, hackathonId: string, teamId: string | null, actorId: string | null, action: string, metadata: object = {}) {
  await client.query(
    `INSERT INTO audit_log (hackathon_id, team_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [hackathonId, teamId, actorId, action, JSON.stringify(metadata)],
  );
}

async function currentHackathon(client: TxClient) {
  const { rows } = await client.query(`SELECT * FROM hackathons ORDER BY created_at DESC LIMIT 1`);
  if (!rows.length) throw errors.notFound('No hackathon configured');
  return rows[0];
}

export default async function teamRoutes(app: FastifyInstance) {
  // ---- Create a team (idempotent; one team per person per hackathon) ----
  app.post('/api/teams', { preHandler: authenticate }, idempotent('create_team', async (req: any) => {
    const body = parse(createTeamSchema, req.body);
    await rateLimit(`create_team:${req.userId}`, 5, 60);
    return withTx(async (c) => {
      const h = await currentHackathon(c);
      const existing = await c.query(`SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2`, [h.id, req.userId]);
      if (existing.rowCount) throw errors.conflict('already_in_team', 'You are already in a team for this hackathon');
      const code = genInviteCode();
      const { rows } = await c.query(
        `INSERT INTO teams (hackathon_id, name, leader_id, invite_code, invite_expires_at, wanted_skills, looking_for_members)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5::int), $6, $7) RETURNING *`,
        [h.id, body.name, req.userId, code, h.invite_code_ttl_minutes, body.wanted_skills, body.looking_for_members],
      );
      const team = rows[0];
      await c.query(`INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'leader')`, [team.id, h.id, req.userId]);
      await audit(c, h.id, team.id, req.userId, 'team_created', { name: team.name });
      return { status: 201, body: { team } };
    });
  }));

  // ---- Join via invite code: THE race-critical path ----
  app.post('/api/teams/join-by-code', { preHandler: authenticate }, idempotent('join_by_code', async (req: any) => {
    const body = parse(joinByCodeSchema, req.body);
    await rateLimit(`join_code:${req.userId}`, 10, 60);
    return withTx(async (c) => {
      // Lock the team row first. Every joiner for this team serializes on this
      // row lock, so the count check below can never be fooled by a parallel join.
      const { rows } = await c.query(
        `SELECT t.id, t.hackathon_id, t.invite_expires_at, h.team_size_max
         FROM teams t JOIN hackathons h ON h.id = t.hackathon_id
         WHERE t.invite_code = $1 FOR UPDATE OF t`,
        [body.code.toUpperCase()],
      );
      const team = rows[0];
      if (!team) throw errors.notFound('Invalid invite code');
      if (new Date(team.invite_expires_at) < new Date()) throw errors.gone('Invite code has expired');
      const member = await c.query(`SELECT 1 FROM team_members WHERE hackathon_id = $1 AND user_id = $2`, [team.hackathon_id, req.userId]);
      if (member.rowCount) throw errors.conflict('already_in_team', 'You are already in a team for this hackathon');
      const count = await c.query(`SELECT count(*)::int AS n FROM team_members WHERE team_id = $1`, [team.id]);
      if (count.rows[0].n >= team.team_size_max) throw errors.conflict('team_full', 'This team is full');
      await c.query(`INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [team.id, team.hackathon_id, req.userId]);
      await audit(c, team.hackathon_id, team.id, req.userId, 'member_joined', { via: 'invite_code' });
      // Membership acquired: every other pending request from this user is
      // cancelled, and each cancellation is audited (same rule as accept).
      const cancelled = await c.query(
        `UPDATE join_requests SET status = 'cancelled', decided_at = now()
         WHERE user_id = $1 AND hackathon_id = $2 AND status = 'pending' RETURNING id, team_id`,
        [req.userId, team.hackathon_id],
      );
      for (const r of cancelled.rows) {
        await audit(c, team.hackathon_id, r.team_id, req.userId, 'join_request_auto_cancelled', { request_id: r.id, reason: 'joined_another_team' });
      }
      return { status: 201, body: { team_id: team.id } };
    });
  }));

  // ---- Team detail (members see invite code; others get public summary) ----
  app.get('/api/teams/:id', { preHandler: authenticate }, async (req: any) => {
    const id = parse(uuidParam, req.params.id);
    const { rows } = await pool.query(
      `SELECT t.*, h.team_size_min, h.team_size_max, h.slug AS hackathon_slug FROM teams t JOIN hackathons h ON h.id = t.hackathon_id WHERE t.id = $1`,
      [id],
    );
    const team = rows[0];
    if (!team) throw errors.notFound('Team not found');
    const members = await pool.query(
      `SELECT tm.user_id, tm.role, tm.joined_at, p.display_name, p.skills, p.timezone
       FROM team_members tm JOIN profiles p ON p.id = tm.user_id WHERE tm.team_id = $1 ORDER BY tm.joined_at`,
      [id],
    );
    const isMember = members.rows.some((m) => m.user_id === req.userId);
    const isLeader = team.leader_id === req.userId;
    let requests: unknown[] = [];
    if (isLeader) {
      const r = await pool.query(
        `SELECT jr.id, jr.user_id, jr.message, jr.status, jr.created_at, p.display_name, p.skills, p.timezone
         FROM join_requests jr JOIN profiles p ON p.id = jr.user_id
         WHERE jr.team_id = $1 AND jr.status = 'pending' ORDER BY jr.created_at`,
        [id],
      );
      requests = r.rows;
    }
    if (!isMember) { delete team.invite_code; delete team.invite_expires_at; }
    return {
      team, members: members.rows, member_count: members.rows.length,
      // A team below team_size_min is allowed (still forming) but flagged.
      is_complete: members.rows.length >= team.team_size_min,
      is_member: isMember, is_leader: isLeader, pending_requests: requests,
    };
  });

  // ---- Join requests ----
  app.post('/api/teams/:id/requests', { preHandler: authenticate }, idempotent('create_join_request', async (req: any) => {
    await rateLimit(`join_request:${req.userId}`, 10, 60);
    const body = parse(joinRequestSchema, req.body);
    const teamId = parse(uuidParam, req.params.id);
    return withTx(async (c) => {
      const { rows } = await c.query(`SELECT id, hackathon_id FROM teams WHERE id = $1`, [teamId]);
      const team = rows[0];
      if (!team) throw errors.notFound('Team not found');
      const member = await c.query(`SELECT 1 FROM team_members WHERE hackathon_id = $1 AND user_id = $2`, [team.hackathon_id, req.userId]);
      if (member.rowCount) throw errors.conflict('already_in_team', 'You are already in a team for this hackathon');
      try {
        const r = await c.query(
          `INSERT INTO join_requests (team_id, hackathon_id, user_id, message) VALUES ($1, $2, $3, $4) RETURNING *`,
          [teamId, team.hackathon_id, req.userId, body.message ?? null],
        );
        await audit(c, team.hackathon_id, teamId, req.userId, 'join_requested', {});
        return { status: 201, body: { request: r.rows[0] } };
      } catch (e: any) {
        if (e.code === '23505') throw errors.conflict('request_already_pending', 'You already have a pending request for this team');
        throw e;
      }
    });
  }));

  app.post('/api/requests/:id/accept', { preHandler: authenticate }, respond(async (req: any) => {
    await rateLimit(`moderate:${req.userId}`, 30, 60);
    parse(uuidParam, req.params.id);
    return withTx(async (c) => {
      // Lock request row AND team row: concurrent accepts for the same team
      // serialize on the team row, so the seat check cannot race.
      const { rows } = await c.query(
        `SELECT jr.*, t.leader_id, h.team_size_max FROM join_requests jr
         JOIN teams t ON t.id = jr.team_id JOIN hackathons h ON h.id = jr.hackathon_id
         WHERE jr.id = $1 FOR UPDATE OF jr, t`,
        [req.params.id],
      );
      const jr = rows[0];
      if (!jr) throw errors.notFound('Request not found');
      if (jr.leader_id !== req.userId) throw errors.forbidden('Only the team leader can accept requests');
      if (jr.status !== 'pending') throw errors.conflict('request_already_decided', `Request is already ${jr.status}`);
      const member = await c.query(`SELECT 1 FROM team_members WHERE hackathon_id = $1 AND user_id = $2`, [jr.hackathon_id, jr.user_id]);
      if (member.rowCount) {
        // The request is stale: cancel it and COMMIT (a thrown conflict would
        // roll the update back). The leader still gets the 409 body.
        await c.query(`UPDATE join_requests SET status = 'cancelled', decided_at = now(), decided_by = $2 WHERE id = $1`, [jr.id, req.userId]);
        await audit(c, jr.hackathon_id, jr.team_id, req.userId, 'join_request_auto_cancelled', { request_id: jr.id, reason: 'requester_already_in_team', user_id: jr.user_id });
        return { status: 409, body: { error: { code: 'requester_already_in_team', message: 'This person has already joined a team; their request was cancelled' } } };
      }
      const count = await c.query(`SELECT count(*)::int AS n FROM team_members WHERE team_id = $1`, [jr.team_id]);
      if (count.rows[0].n >= jr.team_size_max) throw errors.conflict('team_full', 'This team is full');
      await c.query(`UPDATE join_requests SET status = 'accepted', decided_at = now(), decided_by = $2 WHERE id = $1`, [jr.id, req.userId]);
      await c.query(`INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [jr.team_id, jr.hackathon_id, jr.user_id]);
      const others = await c.query(
        `UPDATE join_requests SET status = 'cancelled', decided_at = now()
         WHERE user_id = $1 AND hackathon_id = $2 AND status = 'pending' RETURNING id, team_id`,
        [jr.user_id, jr.hackathon_id],
      );
      for (const r of others.rows) {
        await audit(c, jr.hackathon_id, r.team_id, req.userId, 'join_request_auto_cancelled', { request_id: r.id, reason: 'joined_another_team', user_id: jr.user_id });
      }
      await audit(c, jr.hackathon_id, jr.team_id, req.userId, 'member_joined', { via: 'join_request', request_id: jr.id, user_id: jr.user_id });
      return { status: 200, body: { ok: true } };
    });
  }));

  app.post('/api/requests/:id/decline', { preHandler: authenticate }, respond(async (req: any) => {
    await rateLimit(`moderate:${req.userId}`, 30, 60);
    parse(uuidParam, req.params.id);
    return withTx(async (c) => {
      const { rows } = await c.query(
        // Lock request AND team rows, matching accept: leadership cannot
        // change between the authorization read and the decision write.
        `SELECT jr.*, t.leader_id FROM join_requests jr JOIN teams t ON t.id = jr.team_id WHERE jr.id = $1 FOR UPDATE OF jr, t`,
        [req.params.id],
      );
      const jr = rows[0];
      if (!jr) throw errors.notFound('Request not found');
      if (jr.leader_id !== req.userId) throw errors.forbidden('Only the team leader can decline requests');
      if (jr.status !== 'pending') throw errors.conflict('request_already_decided', `Request is already ${jr.status}`);
      await c.query(`UPDATE join_requests SET status = 'declined', decided_at = now(), decided_by = $2 WHERE id = $1`, [jr.id, req.userId]);
      await audit(c, jr.hackathon_id, jr.team_id, req.userId, 'join_declined', { request_id: jr.id, user_id: jr.user_id });
      return { status: 200, body: { ok: true } };
    });
  }));

  // ---- Leave / remove / leadership rules ----
  app.post('/api/teams/:id/leave', { preHandler: authenticate }, respond(async (req: any) => {
    await rateLimit(`leave:${req.userId}`, 10, 60);
    parse(uuidParam, req.params.id);
    return withTx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM teams WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const team = rows[0];
      if (!team) throw errors.notFound('Team not found');
      const member = await c.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [team.id, req.userId]);
      if (!member.rowCount) throw errors.conflict('not_a_member', 'You are not in this team');
      await c.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [team.id, req.userId]);
      await audit(c, team.hackathon_id, team.id, req.userId, 'member_left', {});
      const rest = await c.query(`SELECT user_id FROM team_members WHERE team_id = $1 ORDER BY joined_at ASC`, [team.id]);
      if (rest.rowCount === 0) {
        await c.query(`DELETE FROM teams WHERE id = $1`, [team.id]);
        await audit(c, team.hackathon_id, team.id, req.userId, 'team_deleted', { reason: 'last_member_left' });
        return { status: 200, body: { left: true, team_deleted: true } };
      }
      if (team.leader_id === req.userId) {
        const newLeader = rest.rows[0].user_id;
        await c.query(`UPDATE teams SET leader_id = $2 WHERE id = $1`, [team.id, newLeader]);
        await c.query(`UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND user_id = $2`, [team.id, newLeader]);
        await audit(c, team.hackathon_id, team.id, req.userId, 'leadership_transferred', { to: newLeader });
      }
      return { status: 200, body: { left: true, team_deleted: false } };
    });
  }));

  app.delete('/api/teams/:id/members/:userId', { preHandler: authenticate }, respond(async (req: any) => {
    await rateLimit(`moderate:${req.userId}`, 30, 60);
    parse(uuidParam, req.params.id);
    parse(uuidParam, req.params.userId);
    return withTx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM teams WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const team = rows[0];
      if (!team) throw errors.notFound('Team not found');
      if (team.leader_id !== req.userId) throw errors.forbidden('Only the team leader can remove members');
      if (req.params.userId === team.leader_id) throw errors.conflict('cannot_remove_leader', 'The leader cannot be removed; leave the team instead');
      const removed = await c.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [team.id, req.params.userId]);
      if (!removed.rowCount) throw errors.notFound('Member not found');
      await audit(c, team.hackathon_id, team.id, req.userId, 'member_removed', { user_id: req.params.userId });
      return { status: 200, body: { ok: true } };
    });
  }));

  app.post('/api/teams/:id/invite/rotate', { preHandler: authenticate }, idempotent('rotate_invite', async (req: any) => {
    parse(uuidParam, req.params.id);
    return withTx(async (c) => {
      const { rows } = await c.query(
        `SELECT t.*, h.invite_code_ttl_minutes FROM teams t JOIN hackathons h ON h.id = t.hackathon_id WHERE t.id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const team = rows[0];
      if (!team) throw errors.notFound('Team not found');
      if (team.leader_id !== req.userId) throw errors.forbidden('Only the team leader can rotate the invite code');
      const code = genInviteCode();
      const updated = await c.query(
        `UPDATE teams SET invite_code = $2, invite_expires_at = now() + make_interval(mins => $3::int) WHERE id = $1 RETURNING invite_code, invite_expires_at`,
        [team.id, code, team.invite_code_ttl_minutes],
      );
      await audit(c, team.hackathon_id, team.id, req.userId, 'invite_rotated', {});
      return { status: 200, body: updated.rows[0] };
    });
  }));

  app.get('/api/teams/:id/audit', { preHandler: authenticate }, async (req: any) => {
    parse(uuidParam, req.params.id);
    const member = await pool.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    if (!member.rowCount) throw errors.forbidden('Only team members can see the audit log');
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.metadata, a.created_at, p.display_name AS actor_name,
              sp.display_name AS subject_name
       FROM audit_log a
       LEFT JOIN profiles p ON p.id = a.actor_id
       LEFT JOIN profiles sp ON sp.id = NULLIF(a.metadata->>'user_id', '')::uuid
       WHERE a.team_id = $1 ORDER BY a.id DESC LIMIT 200`,
      [req.params.id],
    );
    return { audit: rows };
  });
}
