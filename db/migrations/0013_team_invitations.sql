-- Team invitations: the outbound half of the connect journey. Join requests
-- let a person ask a team; invitations let a team ask a person (from the
-- board people tab or suggestions). Same invariants as requests: at most one
-- pending per (team, person), accepting takes a real seat under the team row
-- lock, and every state change is audited.

CREATE TABLE team_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id  uuid NOT NULL REFERENCES hackathons(id),
  user_id       uuid NOT NULL REFERENCES profiles(id),  -- the invited person
  invited_by    uuid NOT NULL REFERENCES profiles(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES profiles(id)
);
-- At most one pending invitation per person per team.
CREATE UNIQUE INDEX team_invitations_one_pending ON team_invitations(team_id, user_id) WHERE status = 'pending';
CREATE INDEX team_invitations_user_pending ON team_invitations(user_id) WHERE status = 'pending';

-- Same durable outbox as the other mutable tables: change rows commit
-- atomically with the data change (see 0004_domain_events.sql). Invitation
-- events are filtered invitee-only in the SSE handlers.
CREATE TRIGGER team_invitations_notify
  AFTER INSERT OR UPDATE OR DELETE ON team_invitations
  FOR EACH ROW EXECUTE FUNCTION notify_board_event();
