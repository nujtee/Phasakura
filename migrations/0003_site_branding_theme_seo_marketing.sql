-- Migration 0003: site settings, branding, theme, fonts, marketing, SEO, floating booking CTA

-- ---------------------------------------------------------------------------
-- Site settings (singleton) + per-language texts
-- ---------------------------------------------------------------------------
CREATE TABLE site_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  default_language TEXT NOT NULL REFERENCES languages (code),
  timezone         TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  currency         TEXT NOT NULL DEFAULT 'THB' CHECK (length(currency) = 3),
  contact_phone    TEXT,
  contact_email    TEXT,
  line_oa_url      TEXT CHECK (line_oa_url IS NULL OR line_oa_url LIKE 'https://%'),
  map_url          TEXT CHECK (map_url IS NULL OR map_url LIKE 'https://%'),
  latitude         REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude        REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by       TEXT REFERENCES users (id)
) STRICT;

CREATE TABLE site_setting_translations (
  language_code TEXT PRIMARY KEY REFERENCES languages (code),
  site_name     TEXT,
  tagline       TEXT,
  address       TEXT,
  footer_text   TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- Branding (spec §36) — files in R2 via media_assets
-- ---------------------------------------------------------------------------
CREATE TABLE branding_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  logo_main_asset_id   TEXT REFERENCES media_assets (id),
  logo_mobile_asset_id TEXT REFERENCES media_assets (id),
  favicon_asset_id     TEXT REFERENCES media_assets (id),
  login_logo_asset_id  TEXT REFERENCES media_assets (id),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by           TEXT REFERENCES users (id)
) STRICT;

-- ---------------------------------------------------------------------------
-- Theme (spec §37–38): versioned tokens with Draft → Preview → Publish → Rollback
-- ---------------------------------------------------------------------------
CREATE TABLE theme_versions (
  id             TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE CHECK (version_number > 0),
  preset         TEXT NOT NULL CHECK (preset IN ('DEFAULT', 'NATURE', 'FOREST', 'MOUNTAIN', 'SAKURA',
                                                  'LUXURY', 'MINIMAL', 'WARM', 'MODERN', 'DARK', 'CUSTOM')),
  tokens_json    TEXT NOT NULL CHECK (json_valid(tokens_json) AND json_type(tokens_json) = 'object'),
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  note           TEXT,
  created_by     TEXT REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_by   TEXT REFERENCES users (id),
  published_at   TEXT
) STRICT;

CREATE UNIQUE INDEX ux_theme_versions_single_published ON theme_versions (status) WHERE status = 'PUBLISHED';

CREATE TABLE theme_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  published_version_id TEXT REFERENCES theme_versions (id),
  draft_version_id     TEXT REFERENCES theme_versions (id),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by           TEXT REFERENCES users (id)
) STRICT;

CREATE TABLE font_settings (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL UNIQUE CHECK (role IN ('BODY', 'HEADING', 'BUTTON')),
  family         TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('SYSTEM', 'GOOGLE', 'UPLOADED')),
  media_asset_id TEXT REFERENCES media_assets (id),
  weights        TEXT NOT NULL DEFAULT '400,700',
  fallback_stack TEXT NOT NULL DEFAULT 'system-ui, sans-serif',
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by     TEXT REFERENCES users (id),
  CHECK ((source = 'UPLOADED') = (media_asset_id IS NOT NULL)),
  CHECK (family NOT GLOB '*[<>";{}]*')
) STRICT;

-- ---------------------------------------------------------------------------
-- Marketing (spec §43–45). IDs only — the CAPI access token lives in
-- Cloudflare Secrets (META_CAPI_ACCESS_TOKEN) and is NEVER stored in D1.
-- ---------------------------------------------------------------------------
CREATE TABLE marketing_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  ga4_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (ga4_enabled IN (0, 1)),
  ga4_measurement_id  TEXT CHECK (ga4_measurement_id IS NULL OR ga4_measurement_id GLOB 'G-[A-Z0-9]*'),
  meta_pixel_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (meta_pixel_enabled IN (0, 1)),
  meta_pixel_id       TEXT CHECK (meta_pixel_id IS NULL OR meta_pixel_id NOT GLOB '*[^0-9]*'),
  meta_capi_enabled   INTEGER NOT NULL DEFAULT 0 CHECK (meta_capi_enabled IN (0, 1)),
  gsc_verification    TEXT CHECK (gsc_verification IS NULL OR gsc_verification NOT GLOB '*[^A-Za-z0-9_-]*'),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by          TEXT REFERENCES users (id),
  CHECK (ga4_enabled = 0 OR ga4_measurement_id IS NOT NULL),
  CHECK (meta_pixel_enabled = 0 OR meta_pixel_id IS NOT NULL)
) STRICT;

-- ---------------------------------------------------------------------------
-- SEO (spec §42)
-- ---------------------------------------------------------------------------
CREATE TABLE seo_settings (
  id                TEXT PRIMARY KEY,
  page_key          TEXT NOT NULL,          -- home, gallery, booking, history, accommodation:<id>, …
  language_code     TEXT NOT NULL REFERENCES languages (code),
  seo_title         TEXT,
  meta_description  TEXT,
  canonical_url     TEXT CHECK (canonical_url IS NULL OR canonical_url LIKE 'https://%'),
  og_title          TEXT,
  og_description    TEXT,
  og_image_asset_id TEXT REFERENCES media_assets (id),
  robots            TEXT NOT NULL DEFAULT 'index,follow'
                    CHECK (robots IN ('index,follow', 'noindex,follow', 'index,nofollow', 'noindex,nofollow')),
  schema_json       TEXT CHECK (schema_json IS NULL OR json_valid(schema_json)),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by        TEXT REFERENCES users (id),
  UNIQUE (page_key, language_code)
) STRICT;

CREATE TABLE seo_redirects (
  id          TEXT PRIMARY KEY,
  from_path   TEXT NOT NULL UNIQUE CHECK (from_path GLOB '/*' AND from_path NOT GLOB '//*'),
  to_path     TEXT NOT NULL CHECK (to_path GLOB '/*' AND to_path NOT GLOB '//*'),
  status_code INTEGER NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 307, 308)),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  hit_count   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users (id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (from_path <> to_path)
) STRICT;

-- ---------------------------------------------------------------------------
-- Floating booking CTA (spec §39)
-- ---------------------------------------------------------------------------
CREATE TABLE booking_cta_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  show_on_desktop  INTEGER NOT NULL DEFAULT 1 CHECK (show_on_desktop IN (0, 1)),
  show_on_mobile   INTEGER NOT NULL DEFAULT 1 CHECK (show_on_mobile IN (0, 1)),
  desktop_position TEXT NOT NULL DEFAULT 'BOTTOM_RIGHT'
                   CHECK (desktop_position IN ('BOTTOM_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER')),
  mobile_position  TEXT NOT NULL DEFAULT 'BOTTOM_BAR'
                   CHECK (mobile_position IN ('BOTTOM_BAR', 'BOTTOM_RIGHT', 'BOTTOM_LEFT')),
  size             TEXT NOT NULL DEFAULT 'MD' CHECK (size IN ('SM', 'MD', 'LG')),
  icon             TEXT NOT NULL DEFAULT 'calendar' CHECK (icon NOT GLOB '*[^a-z0-9-]*'),
  color            TEXT CHECK (color IS NULL OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  animation        TEXT NOT NULL DEFAULT 'NONE' CHECK (animation IN ('NONE', 'PULSE', 'BOUNCE', 'SLIDE_IN')),
  closeable        INTEGER NOT NULL DEFAULT 0 CHECK (closeable IN (0, 1)),
  target_path      TEXT NOT NULL DEFAULT '/{lang}/booking' CHECK (target_path GLOB '/*' AND target_path NOT GLOB '//*'),
  pages_json       TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(pages_json) AND json_type(pages_json) = 'array'),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by       TEXT REFERENCES users (id)
) STRICT;

CREATE TABLE booking_cta_translations (
  language_code TEXT PRIMARY KEY REFERENCES languages (code),
  label         TEXT NOT NULL
) STRICT;
