-- Auth hardening: revocable refresh sessions, single-use action tokens for
-- password reset and email verification, and a verification timestamp on the
-- profile. Access tokens stay stateless JWTs (now short-lived); revocation
-- acts on the refresh path, so the board hot path keeps zero DB reads.
ALTER TABLE profiles ADD COLUMN email_verified_at timestamptz;

CREATE TABLE auth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX auth_refresh_tokens_user_idx ON auth_refresh_tokens(user_id);

-- kind: 'reset' (30 min TTL) or 'verify' (7 day TTL). Consumed atomically by
-- setting used_at in the same UPDATE that validates it (single use by
-- construction, safe under concurrent submits).
CREATE TABLE auth_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reset', 'verify')),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
