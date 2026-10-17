-- Center Management phase C5: site health checks every 5 minutes, alert state, LINE group alerts, settings.

-- Settings (one row). Alert types that are switched on; the LINE group alerts go to.
CREATE TABLE center_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  line_group_id TEXT CHECK (line_group_id IS NULL OR line_group_id GLOB 'C*'),
  alert_types   TEXT NOT NULL DEFAULT '["site_down","schema_outdated","cron_stale","server_errors","config_errors","recovered"]'
                CHECK (json_valid(alert_types) AND json_type(alert_types) = 'array'),
  updated_by    TEXT REFERENCES center_users (id),
  updated_at    TEXT
) STRICT;

INSERT INTO center_settings (id) VALUES (1);

-- LINE groups Center's bot has joined (from the webhook). Pick one in Settings.
CREATE TABLE center_line_groups (
  group_id  TEXT PRIMARY KEY CHECK (group_id GLOB 'C*' AND length(group_id) BETWEEN 10 AND 64),
  name      TEXT CHECK (name IS NULL OR length(name) <= 200),
  joined_at TEXT NOT NULL,
  left_at   TEXT
) STRICT;

-- One row per site per check (kept 14 days).
CREATE TABLE center_site_checks (
  id              INTEGER PRIMARY KEY,
  site            TEXT NOT NULL CHECK (length(site) BETWEEN 1 AND 40),
  checked_at      TEXT NOT NULL,
  http_status     INTEGER NOT NULL,                     -- 0 = unreachable
  health          TEXT,                                  -- ok | degraded (site's own /api/health view)
  database_state  TEXT,
  schema_state    TEXT,
  cron_state      TEXT,
  errors_24h      INTEGER,
  slips_waiting   INTEGER,
  suspended       INTEGER CHECK (suspended IS NULL OR suspended IN (0, 1)),
  problems        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(problems)),   -- alert types seen in this check
  detail          TEXT CHECK (detail IS NULL OR length(detail) <= 500)
) STRICT;

CREATE INDEX ix_center_site_checks_site ON center_site_checks (site, checked_at);
CREATE INDEX ix_center_site_checks_at ON center_site_checks (checked_at);

-- Current state of each (site, alert type): consecutive bad checks, open since, notified.
CREATE TABLE center_alert_states (
  site        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('site_down', 'schema_outdated', 'cron_stale', 'server_errors', 'config_errors')),
  bad_checks  INTEGER NOT NULL DEFAULT 0 CHECK (bad_checks >= 0),
  open_since  TEXT,                                      -- NULL = not open
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (site, type)
) STRICT;

-- Every alert event (opened / resolved / test) and whether LINE took it.
CREATE TABLE center_alert_log (
  id          TEXT PRIMARY KEY,
  site        TEXT,
  type        TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('OPENED', 'RESOLVED', 'TEST')),
  message     TEXT NOT NULL CHECK (length(message) <= 2000),
  delivery    TEXT NOT NULL CHECK (delivery IN ('SENT', 'FAILED', 'OFF', 'NO_GROUP', 'NO_TOKEN')),
  error       TEXT CHECK (error IS NULL OR length(error) <= 300),
  created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX ix_center_alert_log_created ON center_alert_log (created_at);
