-- Session families: one family per login. Rotation stays WITHIN the family
-- (sid = family_id), so racing tabs cannot branch the session into
-- independent persistent sessions, and logout/replay revoke the family
-- atomically. Existing rows become their own family (family_id = id), which
-- keeps in-flight access tokens (sid = row id) valid across the deploy.
ALTER TABLE auth_refresh_tokens ADD COLUMN family_id uuid;
UPDATE auth_refresh_tokens SET family_id = id WHERE family_id IS NULL;
CREATE INDEX auth_refresh_family_idx ON auth_refresh_tokens (family_id) WHERE revoked_at IS NULL;
