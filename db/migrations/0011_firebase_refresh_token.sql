-- Stores the user's Firebase refresh token (AES-256-GCM encrypted at rest,
-- key derived from JWT_SECRET) on the session family's first
-- auth_refresh_tokens row so app-token rotations can prove the underlying
-- Firebase credential is still valid (password reset/change/disable revokes
-- it). Server-only value: never logged, never returned to clients, nulled
-- on family revocation. Rotations check it BEFORE rotating: Google outage
-- yields a state-preserving 503 (the client retries), an invalid credential
-- revokes the whole family.
ALTER TABLE auth_refresh_tokens ADD COLUMN IF NOT EXISTS firebase_refresh_token text;
