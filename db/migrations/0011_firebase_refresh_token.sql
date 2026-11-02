-- Stores the user's Firebase refresh token (AES-256-GCM encrypted at rest,
-- key derived from JWT_SECRET) on the session family's first
-- auth_refresh_tokens row so app-token rotations can prove the underlying
-- Firebase credential is still valid (password reset/change/disable revokes
-- it). Server-only value: never logged, never returned to clients, nulled
-- on family revocation. firebase_check_failed_since implements the bounded
-- outage policy (see routes/auth.ts): rotations proceed for at most
-- FIREBASE_CHECK_OUTAGE_GRACE_MS (default 24h) while Google is unreachable,
-- then turn fail-closed.
ALTER TABLE auth_refresh_tokens ADD COLUMN IF NOT EXISTS firebase_refresh_token text;
ALTER TABLE auth_refresh_tokens ADD COLUMN IF NOT EXISTS firebase_check_failed_since timestamptz;
