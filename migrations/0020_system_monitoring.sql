-- Migration 0020: production monitoring (Phase 16) — cron heartbeat, server error log, `system.view` permission.
-- Non-destructive: two new tables, one new permission granted to SUPER_ADMIN and MANAGER. No existing data changes.

-- ---------------------------------------------------------------------------
-- Last run of each background job (the every-minute cron and its tasks). /api/health reports "stale"
-- when the cron has not finished for 5 minutes, so an uptime monitor notices a stopped trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE system_heartbeats (
  name          TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 40),
  last_run_at   TEXT NOT NULL,
  last_ok_at    TEXT,
  last_status   TEXT NOT NULL CHECK (last_status IN ('OK', 'ERROR')),
  last_error    TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
  duration_ms   INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  runs          INTEGER NOT NULL DEFAULT 0 CHECK (runs >= 0)
) STRICT;

-- ---------------------------------------------------------------------------
-- Unexpected server errors (HTTP 500, failed cron tasks) for the admin "System status" page.
-- No personal data: method, path without the query string, request id, error class and a scrubbed
-- message (e-mails, phone numbers, tokens removed). Kept 30 days. Full logs: Workers Observability.
-- ---------------------------------------------------------------------------
CREATE TABLE error_events (
  id          TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('API', 'PAGE', 'CRON')),
  request_id  TEXT CHECK (request_id IS NULL OR length(request_id) <= 64),
  method      TEXT CHECK (method IS NULL OR length(method) <= 10),
  path        TEXT CHECK (path IS NULL OR length(path) <= 200),
  error_name  TEXT CHECK (error_name IS NULL OR length(error_name) <= 60),
  message     TEXT NOT NULL CHECK (length(message) <= 300)
) STRICT;

CREATE INDEX ix_error_events_time ON error_events (occurred_at);

-- ---------------------------------------------------------------------------
-- Permission: view the System status page (health, configuration warnings, errors).
-- ---------------------------------------------------------------------------
INSERT INTO permissions (id, code, module, description) VALUES
  ('perm_system_view', 'system.view', 'security', 'View system status, configuration warnings and server errors');

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_super_admin', 'perm_system_view'),
  ('role_manager', 'perm_system_view');
