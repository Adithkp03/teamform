-- Pending team invitations expire 7 days after creation (matching the
-- default invite-code TTL): an unanswered invitation should not hold a seat
-- in someone's inbox forever. Expiry is enforced at decision time (accept of
-- an expired invitation is refused and the row is cancelled with an audited
-- 'invitation_expired' reason) and expired rows drop out of the invitee
-- inbox and the team's pending list. Existing pending rows get 7 days from
-- this migration, same as new ones get from creation.
ALTER TABLE team_invitations
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days';
