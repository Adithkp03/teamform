-- TeamForm schema. All invariants that protect correctness under concurrency are
-- expressed in the database itself: unique constraints, foreign keys and explicit
-- row locks. The application can be killed at any point without corrupting state.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE hackathons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  team_size_min int  NOT NULL CHECK (team_size_min >= 1),
  team_size_max int  NOT NULL CHECK (team_size_max >= team_size_min),
  invite_code_ttl_minutes int NOT NULL DEFAULT 10080, -- 7 days
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  id            uuid PRIMARY KEY, -- equals the auth user id in production; synthetic for seed users
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  skills        text[] NOT NULL DEFAULT '{}',
  timezone      text NOT NULL DEFAULT 'UTC',
  utc_offset_minutes int NOT NULL DEFAULT 0,
  looking_for_team boolean NOT NULL DEFAULT true,
  is_seed       boolean NOT NULL DEFAULT false,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id  uuid NOT NULL REFERENCES hackathons(id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  leader_id     uuid NOT NULL REFERENCES profiles(id),
  invite_code   text NOT NULL UNIQUE,
  invite_expires_at timestamptz NOT NULL,
  looking_for_members boolean NOT NULL DEFAULT true,
  wanted_skills text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_board_idx ON teams(hackathon_id, created_at DESC) WHERE looking_for_members;

CREATE TABLE team_members (
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id  uuid NOT NULL REFERENCES hackathons(id),
  user_id       uuid NOT NULL REFERENCES profiles(id),
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('leader','member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  -- Invariant: one team per person per hackathon. This unique index is the final
  -- backstop even if application code has a bug; the row-lock discipline in the
  -- API is what turns violations into clean 409s instead of aborted transactions.
  CONSTRAINT one_team_per_hackathon UNIQUE (hackathon_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id);

CREATE TABLE join_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id  uuid NOT NULL REFERENCES hackathons(id),
  user_id       uuid NOT NULL REFERENCES profiles(id),
  message       text CHECK (message IS NULL OR char_length(message) <= 500),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES profiles(id)
);
-- At most one pending request per user per team.
CREATE UNIQUE INDEX join_requests_one_pending ON join_requests(team_id, user_id) WHERE status = 'pending';
CREATE INDEX join_requests_team_pending_idx ON join_requests(team_id) WHERE status = 'pending';
CREATE INDEX join_requests_user_idx ON join_requests(user_id);

-- Stripe-style idempotency keys: the row itself is the lock. First insert wins the
-- right to execute; retries see in_flight -> 409, completed -> stored response.
CREATE TABLE idempotency_keys (
  key           text NOT NULL,
  user_id       uuid NOT NULL,
  endpoint      text NOT NULL,
  params_hash   text NOT NULL,
  state         text NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight','completed','failed')),
  response_status int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hackathon_id  uuid,
  team_id       uuid,
  actor_id      uuid,
  action        text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_team_idx ON audit_log(team_id, id);
CREATE INDEX audit_log_hackathon_idx ON audit_log(hackathon_id, id);

-- Fixed-window rate limiting without Redis. One row per (key, window); atomic
-- upsert increments. Windows: 'minute' truncation of now().
CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         int NOT NULL,
  PRIMARY KEY (key, window_start)
);
