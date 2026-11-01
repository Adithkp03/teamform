-- Rotation grace: a rotated refresh token stays presentable for a short
-- window (REFRESH_GRACE_MS, default 10s) so two tabs refreshing with the same
-- old token at the same moment both succeed instead of one being treated as
-- an attacker and locking the account. After the window, presenting a
-- rotated token is replay and revokes every session. Logout/reset revoke
-- without rotated_at and never get a grace window.
ALTER TABLE auth_refresh_tokens ADD COLUMN rotated_at timestamptz;
