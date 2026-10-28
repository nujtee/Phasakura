-- Migration 0039: Landscape — a site plan of the property (houses, VIP tents, camping area, gardens, paths…) drawn
-- by staff and shown on the booking page (phase L1). Non-destructive: new tables and permissions only; no booking
-- table is touched. A layout only links to existing units; availability and prices always come from the bookings.
--
-- landscape_settings: one row — the switch (OFF until a SUPER_ADMIN turns it on) and which layout the booking page shows.
-- landscape_layouts: a plan with its working draft (JSON document). draft_revision guards against two admins overwriting
--   each other's work: a save names the revision it started from and is refused (409) when someone saved meanwhile.
-- landscape_versions: what was published, frozen (never updated or deleted): history and rollback.
-- landscape_templates: reusable objects (a styled tree, a house outline…) staff keep for later.

PRAGMA defer_foreign_keys = true;

CREATE TABLE landscape_layouts (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  background_kind      TEXT NOT NULL CHECK (background_kind IN ('BLANK', 'PHOTO', 'SATELLITE')),
  draft_json           TEXT NOT NULL CHECK (json_valid(draft_json) AND length(draft_json) <= 600000),
  draft_revision       INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision >= 1),
  draft_updated_by     TEXT REFERENCES users (id),
  draft_updated_at     TEXT NOT NULL,
  published_version_id TEXT,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by           TEXT REFERENCES users (id),
  created_at           TEXT NOT NULL
) STRICT;

CREATE TABLE landscape_versions (
  id              TEXT PRIMARY KEY,
  layout_id       TEXT NOT NULL REFERENCES landscape_layouts (id),
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  document_json   TEXT NOT NULL CHECK (json_valid(document_json) AND length(document_json) <= 600000),
  note            TEXT CHECK (note IS NULL OR length(note) <= 200),
  -- A version made by publishing an older one again (rollback).
  restored_from   TEXT REFERENCES landscape_versions (id),
  published_by    TEXT REFERENCES users (id),
  published_at    TEXT NOT NULL,
  UNIQUE (layout_id, version_no)
) STRICT;
CREATE INDEX ix_landscape_versions_layout ON landscape_versions (layout_id, version_no);

CREATE TRIGGER trg_landscape_versions_no_update BEFORE UPDATE ON landscape_versions
BEGIN
  SELECT RAISE(ABORT, 'LANDSCAPE_VERSION_IMMUTABLE');
END;
CREATE TRIGGER trg_landscape_versions_no_delete BEFORE DELETE ON landscape_versions
BEGIN
  SELECT RAISE(ABORT, 'LANDSCAPE_VERSION_IMMUTABLE');
END;
-- A layout points only at one of its own versions.
CREATE TRIGGER trg_landscape_layouts_published_own BEFORE UPDATE OF published_version_id ON landscape_layouts
WHEN NEW.published_version_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM landscape_versions v WHERE v.id = NEW.published_version_id AND v.layout_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'LANDSCAPE_VERSION_NOT_OWN');
END;

CREATE TABLE landscape_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  public_layout_id TEXT REFERENCES landscape_layouts (id),
  updated_by       TEXT REFERENCES users (id),
  updated_at       TEXT
) STRICT;
INSERT INTO landscape_settings (id) VALUES (1);

CREATE TABLE landscape_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  object_json   TEXT NOT NULL CHECK (json_valid(object_json) AND length(object_json) <= 20000),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
  created_by    TEXT REFERENCES users (id),
  created_at    TEXT NOT NULL
) STRICT;

INSERT INTO permissions (id, code, module, description) VALUES
  ('perm_landscape_view', 'landscape.view', 'landscape', 'See the landscape (site plan) editor'),
  ('perm_landscape_edit', 'landscape.edit', 'landscape', 'Draw and save landscape drafts'),
  ('perm_landscape_publish', 'landscape.publish', 'landscape', 'Publish a landscape to the booking page, roll back'),
  ('perm_landscape_toggle', 'landscape.toggle', 'landscape', 'Switch the landscape feature on / off (SUPER_ADMIN only)');

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_super_admin', 'perm_landscape_view'), ('role_super_admin', 'perm_landscape_edit'),
  ('role_super_admin', 'perm_landscape_publish'), ('role_super_admin', 'perm_landscape_toggle'),
  ('role_manager', 'perm_landscape_view'), ('role_manager', 'perm_landscape_edit'), ('role_manager', 'perm_landscape_publish'),
  ('role_content_admin', 'perm_landscape_view'), ('role_content_admin', 'perm_landscape_edit'),
  ('role_booking_admin', 'perm_landscape_view');

-- landscape.toggle belongs to the SUPER_ADMIN role alone: never to another role, never granted to one user.
CREATE TRIGGER trg_role_permissions_landscape_toggle BEFORE INSERT ON role_permissions
WHEN NEW.permission_id = 'perm_landscape_toggle' AND NEW.role_id <> 'role_super_admin'
BEGIN
  SELECT RAISE(ABORT, 'LANDSCAPE_TOGGLE_SUPER_ADMIN_ONLY');
END;
CREATE TRIGGER trg_user_permissions_landscape_toggle BEFORE INSERT ON user_permissions
WHEN NEW.permission_id = 'perm_landscape_toggle' AND NEW.effect = 'GRANT'
BEGIN
  SELECT RAISE(ABORT, 'LANDSCAPE_TOGGLE_SUPER_ADMIN_ONLY');
END;

PRAGMA defer_foreign_keys = false;
