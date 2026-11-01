-- Portable auth credentials + Postgres LISTEN/NOTIFY for SSE realtime.
-- Works on any Postgres (Neon, Render, local); does not require Supabase.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS password_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_key ON profiles (lower(email)) WHERE email IS NOT NULL;

-- Thin change signal; clients refetch board state on receipt. Payload stays
-- small (< 8 KB NOTIFY limit) and carries no private data beyond ids.
CREATE OR REPLACE FUNCTION notify_board_event() RETURNS trigger AS $$
DECLARE
  jn jsonb := to_jsonb(NEW);
  jo jsonb := to_jsonb(OLD);
  row_id uuid := COALESCE(jn->>'id', jo->>'id')::uuid;
  team uuid := CASE WHEN TG_TABLE_NAME = 'teams' THEN COALESCE(jn->>'id', jo->>'id')::uuid
                    ELSE COALESCE(jn->>'team_id', jo->>'team_id')::uuid END;
BEGIN
  PERFORM pg_notify('board_events', json_build_object('t', TG_TABLE_NAME, 'op', TG_OP, 'id', row_id, 'team', team, 'at', extract(epoch from now()))::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_teams ON teams;
CREATE TRIGGER trg_notify_teams AFTER INSERT OR UPDATE OR DELETE ON teams FOR EACH ROW EXECUTE FUNCTION notify_board_event();
DROP TRIGGER IF EXISTS trg_notify_members ON team_members;
CREATE TRIGGER trg_notify_members AFTER INSERT OR UPDATE OR DELETE ON team_members FOR EACH ROW EXECUTE FUNCTION notify_board_event();
DROP TRIGGER IF EXISTS trg_notify_requests ON join_requests;
CREATE TRIGGER trg_notify_requests AFTER INSERT OR UPDATE OR DELETE ON join_requests FOR EACH ROW EXECUTE FUNCTION notify_board_event();
DROP TRIGGER IF EXISTS trg_notify_profiles ON profiles;
CREATE TRIGGER trg_notify_profiles AFTER UPDATE OF looking_for_team, skills ON profiles FOR EACH ROW EXECUTE FUNCTION notify_board_event();
