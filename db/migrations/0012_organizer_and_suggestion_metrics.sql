-- 0012: organizer operations support + suggestion-quality instrumentation.

-- One row per served candidate per suggestions fetch, so ranking quality can
-- be measured against real downstream outcomes (candidate joins a team,
-- direct usefulness votes) instead of asserted. Fire-and-forget writes from
-- the suggestions endpoint; analytics only, never read on a hot path.
CREATE TABLE suggestion_impressions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES profiles(id),
  candidate_id uuid NOT NULL REFERENCES profiles(id),
  score        int  NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suggestion_impressions_user_idx ON suggestion_impressions(user_id, id DESC);
CREATE INDEX suggestion_impressions_candidate_idx ON suggestion_impressions(candidate_id, id DESC);

-- Direct per-suggestion feedback ("was this suggestion useful?"). One vote per
-- (user, candidate); a changed mind updates the existing row.
CREATE TABLE suggestion_feedback (
  user_id      uuid NOT NULL REFERENCES profiles(id),
  candidate_id uuid NOT NULL REFERENCES profiles(id),
  useful       boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, candidate_id)
);
