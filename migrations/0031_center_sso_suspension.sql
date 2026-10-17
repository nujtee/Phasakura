-- Center Management phase C3: Center users, one-time SSO tickets, site suspension.
--
-- Center users are ordinary rows in `users` whose id starts with 'center_' (site ids are UUIDs and never do).
-- Only the signed Center API creates them; the site's own admins never see or change them, and they never count
-- as one of the site's own SUPER_ADMINs. Their password_hash is not a PHC string, so a password never matches.

-- The last-SUPER_ADMIN safety net counts the site's own accounts only: a Center user holding SUPER_ADMIN
-- must not let the site's last real SUPER_ADMIN be removed, and removing a Center user's role is never blocked.
DROP TRIGGER trg_keep_last_super_admin_role;
CREATE TRIGGER trg_keep_last_super_admin_role BEFORE DELETE ON user_roles
WHEN OLD.role_id = (SELECT id FROM roles WHERE code = 'SUPER_ADMIN')
 AND substr(OLD.user_id, 1, 7) <> 'center_'
 AND (SELECT status FROM users WHERE id = OLD.user_id) = 'ACTIVE'
 AND (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
       WHERE ur.role_id = OLD.role_id AND u.status = 'ACTIVE' AND ur.user_id <> OLD.user_id
         AND substr(u.id, 1, 7) <> 'center_') = 0
BEGIN
  SELECT RAISE(ABORT, 'LAST_SUPER_ADMIN');
END;

DROP TRIGGER trg_keep_last_super_admin_status;
CREATE TRIGGER trg_keep_last_super_admin_status BEFORE UPDATE OF status ON users
WHEN OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE'
 AND substr(OLD.id, 1, 7) <> 'center_'
 AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = OLD.id AND r.code = 'SUPER_ADMIN')
 AND (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
       WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE' AND u.id <> OLD.id
         AND substr(u.id, 1, 7) <> 'center_') = 0
BEGIN
  SELECT RAISE(ABORT, 'LAST_SUPER_ADMIN');
END;

-- A site account can never become a Center account (or the reverse) by changing its id.
CREATE TRIGGER trg_users_center_id_locked BEFORE UPDATE OF id ON users
BEGIN
  SELECT RAISE(ABORT, 'USER_ID_LOCKED');
END;

-- One-time SSO tickets (60 seconds). Only the SHA-256 of the ticket is stored.
CREATE TABLE center_sso_tickets (
  ticket_hash TEXT PRIMARY KEY CHECK (length(ticket_hash) = 64),
  user_id     TEXT NOT NULL REFERENCES users (id) CHECK (substr(user_id, 1, 7) = 'center_'),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_center_sso_tickets_expires ON center_sso_tickets (expires_at);

-- Site suspended by Center. A row = suspended. The only allowed reason is unpaid service fees.
-- While suspended, guests cannot make new bookings; existing bookings, the back office and data export keep working.
CREATE TABLE site_suspension (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  reason_code  TEXT NOT NULL CHECK (reason_code = 'UNPAID_FEES'),
  note         TEXT CHECK (note IS NULL OR length(note) <= 300),
  suspended_by TEXT NOT NULL REFERENCES users (id) CHECK (substr(suspended_by, 1, 7) = 'center_'),
  suspended_at TEXT NOT NULL
) STRICT;
