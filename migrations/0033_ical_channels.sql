-- Migration 0033: OTA channels — on/off switch and iCal calendar sync with Booking.com / Agoda (phase O1).
-- Non-destructive: new tables, one new column (NULL for every existing row), new permissions.

PRAGMA defer_foreign_keys = true;

-- One row: which channel features this site uses. Both start OFF; only a SUPER_ADMIN (or Center) switches them.
CREATE TABLE channel_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  ical_enabled    INTEGER NOT NULL DEFAULT 0 CHECK (ical_enabled IN (0, 1)),
  channex_enabled INTEGER NOT NULL DEFAULT 0 CHECK (channex_enabled IN (0, 1)),
  updated_by      TEXT REFERENCES users (id),
  updated_at      TEXT
) STRICT;
INSERT INTO channel_settings (id) VALUES (1);

-- One feed per unit (house / VIP tent) and channel.
--  export_token: the secret in this site's calendar URL that the OTA reads (/api/public/ical/<token>.ics).
--    The calendar of a channel leaves out the nights imported from that same channel (no echo).
--  import_url: the OTA's own calendar URL; its nights become blocks here (booking_unit_nights.ical_feed_id).
CREATE TABLE ical_feeds (
  id                 TEXT PRIMARY KEY,
  unit_id            TEXT NOT NULL REFERENCES accommodation_units (id),
  channel            TEXT NOT NULL CHECK (channel IN ('BOOKING', 'AGODA')),
  export_token       TEXT NOT NULL UNIQUE CHECK (length(export_token) = 43),
  import_url         TEXT CHECK (import_url IS NULL OR (length(import_url) <= 2000 AND substr(import_url, 1, 8) = 'https://')),
  last_import_at     TEXT,
  last_import_status TEXT CHECK (last_import_status IS NULL OR last_import_status IN ('OK', 'ERROR')),
  last_import_error  TEXT CHECK (last_import_error IS NULL OR length(last_import_error) <= 300),
  last_import_nights INTEGER CHECK (last_import_nights IS NULL OR last_import_nights >= 0),
  last_export_at     TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (unit_id, channel)
) STRICT;

-- An admin block that came from an iCal feed (NULL = a booking or a block made by staff).
ALTER TABLE booking_unit_nights ADD COLUMN ical_feed_id TEXT REFERENCES ical_feeds (id);
CREATE INDEX ix_booking_unit_nights_ical ON booking_unit_nights (ical_feed_id, stay_date) WHERE ical_feed_id IS NOT NULL;

-- A night the OTA sold that is already booked here (double booking): kept until it goes away on either side.
CREATE TABLE ical_conflicts (
  feed_id       TEXT NOT NULL REFERENCES ical_feeds (id),
  stay_date     TEXT NOT NULL CHECK (date(stay_date) = stay_date),
  booking_id    TEXT REFERENCES bookings (id),
  summary       TEXT CHECK (summary IS NULL OR length(summary) <= 200),
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (feed_id, stay_date)
) STRICT;

INSERT INTO permissions (id, code, module, description) VALUES
  ('perm_channels_view', 'channels.view', 'channels', 'See OTA channel connections (iCal / Channex)'),
  ('perm_channels_edit', 'channels.edit', 'channels', 'Manage OTA calendar links (iCal URLs, sync now)'),
  ('perm_channels_toggle', 'channels.toggle', 'channels', 'Switch OTA channel features on / off (SUPER_ADMIN only)');

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_super_admin', 'perm_channels_view'), ('role_super_admin', 'perm_channels_edit'), ('role_super_admin', 'perm_channels_toggle'),
  ('role_manager', 'perm_channels_view'), ('role_manager', 'perm_channels_edit'),
  ('role_booking_admin', 'perm_channels_view');

-- channels.toggle belongs to the SUPER_ADMIN role alone: never to another role, never granted to one user.
CREATE TRIGGER trg_role_permissions_channels_toggle BEFORE INSERT ON role_permissions
WHEN NEW.permission_id = 'perm_channels_toggle' AND NEW.role_id <> 'role_super_admin'
BEGIN
  SELECT RAISE(ABORT, 'CHANNELS_TOGGLE_SUPER_ADMIN_ONLY');
END;
CREATE TRIGGER trg_user_permissions_channels_toggle BEFORE INSERT ON user_permissions
WHEN NEW.permission_id = 'perm_channels_toggle' AND NEW.effect = 'GRANT'
BEGIN
  SELECT RAISE(ABORT, 'CHANNELS_TOGGLE_SUPER_ADMIN_ONLY');
END;

PRAGMA defer_foreign_keys = false;
