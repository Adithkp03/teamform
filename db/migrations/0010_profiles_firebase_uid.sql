-- Links a profile to its Firebase identity (one Firebase uid <-> one
-- profile). Written only by the firebase exchange/claim routes after the
-- ID token is verified server-side and email equality plus the legacy
-- password/session gate pass; NULL for legacy-only accounts. The partial
-- unique index makes a second claim of the same Firebase identity fail
-- instead of silently re-linking.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS firebase_uid text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_firebase_uid_key ON profiles (firebase_uid) WHERE firebase_uid IS NOT NULL;
