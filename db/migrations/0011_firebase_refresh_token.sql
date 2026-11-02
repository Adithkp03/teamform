-- Stores the user's Firebase refresh token on the session family's first
-- auth_refresh_tokens row so app-token rotations can verify the underlying
-- Firebase credential is still valid (password reset/change revokes it).
-- Server-only value; never returned to clients.
ALTER TABLE auth_refresh_tokens ADD COLUMN IF NOT EXISTS firebase_refresh_token text;
