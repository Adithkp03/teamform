-- member_count is board-visible (the /api/board payload includes it), so a
-- change in the actual count must invalidate board clients: recreate
-- trg_notify_teams to also fire on member_count updates. Membership changes
-- still emit their own team_members events; consumers must tolerate both.
-- Reverts the column restriction added in 0005 for the counter column only.
DROP TRIGGER trg_notify_teams ON teams;
CREATE TRIGGER trg_notify_teams AFTER INSERT OR DELETE
  OR UPDATE OF name, leader_id, invite_code, invite_expires_at, looking_for_members, wanted_skills, member_count
  ON teams FOR EACH ROW EXECUTE FUNCTION notify_board_event();
