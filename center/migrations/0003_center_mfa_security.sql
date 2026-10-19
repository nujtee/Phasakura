-- Center Management phase C9: two-step sign-in (TOTP), recovery codes, step-up for sensitive actions,
-- backup freshness alerts and security alerts.

-- TOTP (RFC 6238, 30 s, 6 digits, SHA-1 — what every authenticator app speaks).
-- totp_pending_secret: shown during set-up until the first code proves the app has it.
-- totp_last_step: the last accepted time step — a code is never accepted twice.
ALTER TABLE center_users ADD COLUMN totp_secret TEXT CHECK (totp_secret IS NULL OR length(totp_secret) BETWEEN 16 AND 64);
ALTER TABLE center_users ADD COLUMN totp_pending_secret TEXT CHECK (totp_pending_secret IS NULL OR length(totp_pending_secret) BETWEEN 16 AND 64);
ALTER TABLE center_users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE center_users ADD COLUMN totp_last_step INTEGER;

-- A session is "two-step done" from mfa_at; sensitive actions want it recent (step-up).
ALTER TABLE center_sessions ADD COLUMN mfa_at TEXT;

-- One-time recovery codes (SHA-256 only), for a lost phone.
CREATE TABLE center_recovery_codes (
  code_hash  TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  user_id    TEXT NOT NULL REFERENCES center_users (id),
  created_at TEXT NOT NULL,
  used_at    TEXT
) STRICT;

CREATE INDEX ix_center_recovery_codes_user ON center_recovery_codes (user_id);

-- Failed sign-ins by IP (throttle across accounts, unknown e-mails included).
CREATE INDEX ix_center_audit_ip ON center_audit (ip, created_at);

-- New alert type: no fresh database backup on a site.
CREATE TABLE center_alert_states_new (
  site        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('site_down', 'schema_outdated', 'cron_stale', 'server_errors', 'config_errors', 'backup_stale')),
  bad_checks  INTEGER NOT NULL DEFAULT 0 CHECK (bad_checks >= 0),
  open_since  TEXT,
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (site, type)
) STRICT;
INSERT INTO center_alert_states_new SELECT site, type, bad_checks, open_since, detail, updated_at FROM center_alert_states;
DROP TABLE center_alert_states;
ALTER TABLE center_alert_states_new RENAME TO center_alert_states;

-- Security events (account locked, two-step reset, new platform owner) go to LINE too.
CREATE TABLE center_alert_log_new (
  id          TEXT PRIMARY KEY,
  site        TEXT,
  type        TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('OPENED', 'RESOLVED', 'TEST', 'SECURITY')),
  message     TEXT NOT NULL CHECK (length(message) <= 2000),
  delivery    TEXT NOT NULL CHECK (delivery IN ('SENT', 'FAILED', 'OFF', 'NO_GROUP', 'NO_TOKEN')),
  error       TEXT CHECK (error IS NULL OR length(error) <= 300),
  created_at  TEXT NOT NULL
) STRICT;
INSERT INTO center_alert_log_new SELECT id, site, type, event, message, delivery, error, created_at FROM center_alert_log;
DROP TABLE center_alert_log;
ALTER TABLE center_alert_log_new RENAME TO center_alert_log;
CREATE INDEX ix_center_alert_log_created ON center_alert_log (created_at);

-- Both new alert types start switched on.
UPDATE center_settings
   SET alert_types = json_insert(json_insert(alert_types, '$[#]', 'backup_stale'), '$[#]', 'security')
 WHERE id = 1;
