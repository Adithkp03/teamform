-- Board performance: the /api/board endpoint is the load-test target
-- (p95 < 200 ms at 100 concurrent users). Measured on the full seed
-- (10,003 profiles / 2,000 teams / 6,000 members), the two board queries
-- burn ~8 ms of Postgres CPU per request (EXPLAIN ANALYZE, shared buffers),
-- which is what saturates the database at ~290 req/s.
--
-- 1. teams.member_count: maintained transactionally by trigger on
--    team_members, so the board query no longer aggregates all 6,000
--    membership rows per request. Display/filter only: seat enforcement
--    still locks the team row and counts live (see teams routes), so the
--    50-racers/1-seat property does not depend on this column.
ALTER TABLE teams ADD COLUMN member_count int NOT NULL DEFAULT 0;
UPDATE teams t SET member_count = c.n
FROM (SELECT team_id, count(*)::int AS n FROM team_members GROUP BY team_id) c
WHERE t.id = c.team_id;

CREATE OR REPLACE FUNCTION team_members_count_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE teams SET member_count = member_count + 1 WHERE id = NEW.team_id;
    RETURN NEW;
  ELSE
    UPDATE teams SET member_count = member_count - 1 WHERE id = OLD.team_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_team_members_count_ins AFTER INSERT ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_count_trigger();
CREATE TRIGGER trg_team_members_count_del AFTER DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_count_trigger();

-- 2. People side of the board: partial index on looking people ordered by
--    last activity, so the NOT EXISTS anti-join becomes indexed lookups
--    instead of hashing all 6,000 team_members per request.
CREATE INDEX profiles_board_idx ON profiles (last_active_at DESC) WHERE looking_for_team;

-- 3. The counter trigger above UPDATEs teams on every membership change,
-- which would otherwise fire trg_notify_teams and double the domain-event
-- stream (observed: SSE contiguity test saw 30 events for 10 team creates
-- instead of 20). Recreate that trigger so UPDATEs only fire it when a
-- board-visible column changes; membership changes already emit their own
-- team_members events.
DROP TRIGGER trg_notify_teams ON teams;
CREATE TRIGGER trg_notify_teams AFTER INSERT OR DELETE
  OR UPDATE OF name, leader_id, invite_code, invite_expires_at, looking_for_members, wanted_skills
  ON teams FOR EACH ROW EXECUTE FUNCTION notify_board_event();
