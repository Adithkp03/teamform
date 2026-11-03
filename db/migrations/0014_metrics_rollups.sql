-- Durable operational telemetry: 5-minute per-route rollups of the in-process
-- counters. Bounded by a 14-day retention (pruned on every flush); route names
-- are Fastify route templates (:id), never concrete IDs - no PII.
CREATE TABLE IF NOT EXISTS metrics_rollups (
  window_start timestamptz NOT NULL,
  route text NOT NULL,
  requests int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,
  latency_counts int[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (window_start, route)
);
CREATE INDEX IF NOT EXISTS metrics_rollups_window ON metrics_rollups (window_start);
