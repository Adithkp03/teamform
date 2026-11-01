-- Production-only (Supabase): expose board-relevant tables over Realtime and
-- restrict direct table access. The API connects as the table owner and bypasses
-- RLS; browsers connect with the anon key + their auth JWT and get read-only
-- access to board data. Run with db/migrate.mjs only against Supabase
-- (RUN_REALTIME_MIGRATION=true).
ALTER PUBLICATION supabase_realtime ADD TABLE teams;
ALTER PUBLICATION supabase_realtime ADD TABLE team_members;
ALTER PUBLICATION supabase_realtime ADD TABLE join_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE profiles;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hackathons ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY read_teams ON teams FOR SELECT TO authenticated USING (true);
CREATE POLICY read_members ON team_members FOR SELECT TO authenticated USING (true);
CREATE POLICY read_requests ON join_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY read_profiles ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY read_hackathons ON hackathons FOR SELECT TO authenticated USING (true);
CREATE POLICY read_audit ON audit_log FOR SELECT TO authenticated USING (true);
