-- Firebase Authentication is the credential authority: sign-in, email
-- verification and password reset live there. A profile is bound to exactly
-- one Firebase uid; the retired password columns are left in place as
-- historical data (no live code path reads them).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS firebase_uid text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_firebase_uid_key ON profiles (firebase_uid) WHERE firebase_uid IS NOT NULL;
