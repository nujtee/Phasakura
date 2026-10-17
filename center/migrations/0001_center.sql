-- Center Management console (phase C4): people, sessions, one-time setup links, audit log.
-- Center keeps no guest data: it reads a site only through that site's signed /api/center/* endpoints.

-- People who work in Center. id = the actor id sent to every site (lower-case, so the site's
-- "<id>@center.invalid" account never clashes by case).
CREATE TABLE center_users (
  id                 TEXT PRIMARY KEY CHECK (id GLOB 'u_[0-9a-f]*' AND length(id) BETWEEN 10 AND 40),
  email              TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email LIKE '%_@_%'),
  display_name       TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  role               TEXT NOT NULL CHECK (role IN ('PLATFORM_OWNER', 'OPERATOR', 'SUPPORT_READONLY')),
  password_hash      TEXT,                                  -- NULL until the person sets it through their setup link
  status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until       TEXT,
  last_login_at      TEXT,
  created_by         TEXT REFERENCES center_users (id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- At least one active PLATFORM_OWNER always remains (the service checks first; this makes it impossible to bypass).
CREATE TRIGGER trg_center_keep_last_owner BEFORE UPDATE OF role, status ON center_users
WHEN OLD.role = 'PLATFORM_OWNER' AND OLD.status = 'ACTIVE' AND (NEW.role <> 'PLATFORM_OWNER' OR NEW.status <> 'ACTIVE')
 AND (SELECT COUNT(*) FROM center_users WHERE role = 'PLATFORM_OWNER' AND status = 'ACTIVE' AND id <> OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'LAST_PLATFORM_OWNER');
END;

-- People are disabled, never deleted (the audit log keeps pointing at them).
CREATE TRIGGER trg_center_users_no_delete BEFORE DELETE ON center_users
BEGIN
  SELECT RAISE(ABORT, 'CENTER_USERS_ARE_NEVER_DELETED');
END;

CREATE TABLE center_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES center_users (id),
  token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  ip           TEXT,
  user_agent   TEXT
) STRICT;

CREATE INDEX ix_center_sessions_user ON center_sessions (user_id);
CREATE INDEX ix_center_sessions_expires ON center_sessions (expires_at);

-- One-time links to set a password (invite or reset). Only the SHA-256 of the token is stored.
CREATE TABLE center_setup_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id    TEXT NOT NULL REFERENCES center_users (id),
  purpose    TEXT NOT NULL CHECK (purpose IN ('INVITE', 'RESET')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_by TEXT REFERENCES center_users (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_center_setup_tokens_user ON center_setup_tokens (user_id);

-- Who did what, to which site, and why. Append-only.
CREATE TABLE center_audit (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES center_users (id),
  action      TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  site        TEXT CHECK (site IS NULL OR length(site) <= 40),
  reason      TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  ip          TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX ix_center_audit_created ON center_audit (created_at);

CREATE TRIGGER trg_center_audit_no_update BEFORE UPDATE ON center_audit
BEGIN
  SELECT RAISE(ABORT, 'CENTER_AUDIT_IS_APPEND_ONLY');
END;

CREATE TRIGGER trg_center_audit_no_delete BEFORE DELETE ON center_audit
BEGIN
  SELECT RAISE(ABORT, 'CENTER_AUDIT_IS_APPEND_ONLY');
END;
