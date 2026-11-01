-- Durable event outbox for serverless realtime (poll mode).
--
-- Why: LISTEN/NOTIFY needs a long-lived session per consumer. On serverless
-- (Vercel) each connected client is a separate function instance; one direct
-- Postgres session per client exceeds Neon's free max_connections (104), and
-- the pooler (PgBouncer transaction mode) cannot carry LISTEN. So on
-- serverless, triggers write thin change rows here IN THE SAME TRANSACTION as
-- the data change, and SSE handlers poll this table through the pooler.
--
-- Reliability guarantee (no lookback, no silent skips):
--   * Insert-time ids (this table's identity id) are allocated before commit,
--     so commit order can differ from id order. Consumers therefore never
--     cursor on id.
--   * A dispatcher assigns dispatched_seq ONLY to committed-visible rows,
--     inside a transaction holding pg_try_advisory_xact_lock (727274). The
--     lock serializes dispatch transactions, so dispatched_seq ranges become
--     visible in strictly increasing commit order. In-flight inserts are
--     invisible to the dispatcher's snapshot and are assigned by a later
--     dispatch; rolled-back inserts are never visible and never assigned.
--   * Consumers read WHERE dispatched_seq > cursor ORDER BY dispatched_seq.
--     Because assignment is serialized with visibility, a cursor never skips
--     a committed event. A dispatcher rollback burns sequence values (gaps
--     with no rows), which consumers tolerate; it never skips a row.
--   * Reconnect: client sends its last dispatched_seq (Last-Event-ID header);
--     if it fell behind pruning, the server sends a `sync` event and the
--     client refetches full state.

CREATE TABLE IF NOT EXISTS domain_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  t              text NOT NULL,          -- source table: teams | team_members | join_requests | profiles
  op             text NOT NULL,          -- INSERT | UPDATE | DELETE
  row_id         uuid,
  team_id        uuid,
  dispatched_seq bigint,                 -- NULL until the dispatcher assigns it
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS domain_events_dispatched_seq_key ON domain_events (dispatched_seq) WHERE dispatched_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS domain_events_undispatched ON domain_events (id) WHERE dispatched_seq IS NULL;
CREATE SEQUENCE IF NOT EXISTS domain_events_dispatch_seq;

CREATE OR REPLACE FUNCTION notify_board_event() RETURNS trigger AS $$
DECLARE
  jn jsonb := to_jsonb(NEW);
  jo jsonb := to_jsonb(OLD);
  row_id uuid := COALESCE(jn->>'id', jo->>'id')::uuid;
  team uuid := CASE WHEN TG_TABLE_NAME = 'teams' THEN COALESCE(jn->>'id', jo->>'id')::uuid
                    ELSE COALESCE(jn->>'team_id', jo->>'team_id')::uuid END;
BEGIN
  -- Durable outbox row (poll mode; committed atomically with the change).
  INSERT INTO domain_events (t, op, row_id, team_id) VALUES (TG_TABLE_NAME, TG_OP, row_id, team);
  -- Best-effort live signal (listen mode; self-hosted/Docker deployments).
  PERFORM pg_notify('board_events', json_build_object('t', TG_TABLE_NAME, 'op', TG_OP, 'id', row_id, 'team', team, 'at', extract(epoch from now()))::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Opportunistic retention: dispatch transactions prune events older than a day.
