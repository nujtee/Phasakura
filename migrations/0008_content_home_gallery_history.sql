-- Migration 0008: website content CMS — Home (sections, hero slides, versions), Gallery, History

-- ---------------------------------------------------------------------------
-- Home sections (spec §8)
-- ---------------------------------------------------------------------------
CREATE TABLE home_sections (
  id            TEXT PRIMARY KEY,
  section_type  TEXT NOT NULL CHECK (section_type IN (
                  'INTRODUCTION', 'ACCOMMODATION_HIGHLIGHTS', 'GALLERY_PREVIEW', 'HISTORY_PREVIEW',
                  'FOOD_PREVIEW', 'BOOKING_CTA', 'LOCATION', 'CONTACT', 'CUSTOM')),
  media_asset_id TEXT REFERENCES media_assets (id),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json) AND json_type(settings_json) = 'object'),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED')),
  updated_by    TEXT REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_home_sections_status_sort ON home_sections (status, sort_order);

CREATE TABLE home_section_translations (
  section_id    TEXT NOT NULL REFERENCES home_sections (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  title         TEXT,
  subtitle      TEXT,
  body          TEXT,                 -- plain text / sanitized markdown, never raw HTML
  button_label  TEXT,
  button_url    TEXT CHECK (button_url IS NULL OR button_url GLOB '/*' OR button_url LIKE 'https://%'),
  PRIMARY KEY (section_id, language_code),
  CHECK (button_url IS NULL OR button_url NOT GLOB '//*')
) STRICT;

-- ---------------------------------------------------------------------------
-- Hero slideshow (spec §9)
-- ---------------------------------------------------------------------------
CREATE TABLE home_slides (
  id                     TEXT PRIMARY KEY,
  desktop_asset_id       TEXT NOT NULL REFERENCES media_assets (id),
  mobile_asset_id        TEXT REFERENCES media_assets (id),
  overlay_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (overlay_enabled IN (0, 1)),
  overlay_color          TEXT NOT NULL DEFAULT '#000000'
                         CHECK (overlay_color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  overlay_opacity        INTEGER NOT NULL DEFAULT 35 CHECK (overlay_opacity BETWEEN 0 AND 100),
  content_position       TEXT NOT NULL DEFAULT 'CENTER'
                         CHECK (content_position IN ('LEFT', 'CENTER', 'RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER')),
  button1_url            TEXT CHECK (button1_url IS NULL OR ((button1_url GLOB '/*' OR button1_url LIKE 'https://%') AND button1_url NOT GLOB '//*')),
  button2_url            TEXT CHECK (button2_url IS NULL OR ((button2_url GLOB '/*' OR button2_url LIKE 'https://%') AND button2_url NOT GLOB '//*')),
  start_at               TEXT,
  end_at                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT', 'PUBLISHED', 'SCHEDULED', 'EXPIRED', 'INACTIVE')),
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_by             TEXT REFERENCES users (id),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at),
  CHECK (status <> 'SCHEDULED' OR start_at IS NOT NULL)
) STRICT;

CREATE INDEX ix_home_slides_status ON home_slides (status, sort_order);
CREATE INDEX ix_home_slides_window ON home_slides (start_at, end_at);
CREATE INDEX ix_home_slides_sort ON home_slides (sort_order);

CREATE TABLE home_slide_translations (
  slide_id      TEXT NOT NULL REFERENCES home_slides (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  title         TEXT,
  subtitle      TEXT,
  description   TEXT,
  button1_label TEXT,
  button2_label TEXT,
  image_alt     TEXT,
  PRIMARY KEY (slide_id, language_code)
) STRICT;

-- Published snapshots of the whole home page (for preview / rollback).
CREATE TABLE home_versions (
  id             TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE CHECK (version_number > 0),
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  note           TEXT,
  created_by     TEXT REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at   TEXT,
  published_by   TEXT REFERENCES users (id)
) STRICT;

CREATE UNIQUE INDEX ux_home_versions_single_published ON home_versions (status) WHERE status = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Gallery (spec §10) — only PUBLISHED is public
-- ---------------------------------------------------------------------------
CREATE TABLE gallery_categories (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE CHECK (slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 1 AND 80),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'DELETED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_gallery_categories_status ON gallery_categories (status, sort_order);

CREATE TABLE gallery_category_translations (
  category_id   TEXT NOT NULL REFERENCES gallery_categories (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  name          TEXT NOT NULL,
  description   TEXT,
  PRIMARY KEY (category_id, language_code)
) STRICT;

CREATE TABLE gallery_images (
  id             TEXT PRIMARY KEY,
  category_id    TEXT REFERENCES gallery_categories (id),
  media_asset_id TEXT NOT NULL REFERENCES media_assets (id),
  layout_span    TEXT NOT NULL DEFAULT 'NORMAL' CHECK (layout_span IN ('NORMAL', 'WIDE', 'TALL', 'LARGE')),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'DELETED')),
  published_at   TEXT,
  created_by     TEXT REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_gallery_images_category ON gallery_images (category_id, status, sort_order);
CREATE INDEX ix_gallery_images_status ON gallery_images (status, sort_order);

CREATE TABLE gallery_image_translations (
  image_id      TEXT NOT NULL REFERENCES gallery_images (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  alt_text      TEXT,
  title         TEXT,
  caption       TEXT,
  PRIMARY KEY (image_id, language_code)
) STRICT;

-- ---------------------------------------------------------------------------
-- History (spec §11)
-- ---------------------------------------------------------------------------
CREATE TABLE history_sections (
  id             TEXT PRIMARY KEY,
  section_type   TEXT NOT NULL CHECK (section_type IN (
                   'HERO', 'INTRODUCTION', 'STORY', 'IMAGE_TEXT', 'TIMELINE', 'GALLERY', 'QUOTE', 'CTA')),
  media_asset_id TEXT REFERENCES media_assets (id),
  layout         TEXT NOT NULL DEFAULT 'DEFAULT' CHECK (layout IN ('DEFAULT', 'IMAGE_LEFT', 'IMAGE_RIGHT', 'FULL_WIDTH')),
  settings_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json) AND json_type(settings_json) = 'object'),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'DELETED')),
  updated_by     TEXT REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_history_sections_status ON history_sections (status, sort_order);

CREATE TABLE history_translations (
  section_id    TEXT NOT NULL REFERENCES history_sections (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  title         TEXT,
  subtitle      TEXT,
  body          TEXT,
  quote_author  TEXT,
  button_label  TEXT,
  button_url    TEXT CHECK (button_url IS NULL OR ((button_url GLOB '/*' OR button_url LIKE 'https://%') AND button_url NOT GLOB '//*')),
  image_alt     TEXT,
  PRIMARY KEY (section_id, language_code)
) STRICT;

CREATE TABLE history_timeline (
  id             TEXT PRIMARY KEY,
  year           INTEGER NOT NULL CHECK (year BETWEEN 1000 AND 9999),   -- CE; display may convert to BE
  media_asset_id TEXT REFERENCES media_assets (id),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'DELETED')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_history_timeline_status ON history_timeline (status, sort_order, year);

CREATE TABLE history_timeline_translations (
  timeline_id   TEXT NOT NULL REFERENCES history_timeline (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  title         TEXT NOT NULL,
  description   TEXT,
  image_alt     TEXT,
  PRIMARY KEY (timeline_id, language_code)
) STRICT;
