-- Migration 0002: media assets (metadata for every object stored in R2)
--
-- Files live in R2; D1 holds the metadata. `bucket` decides the access policy:
--   PUBLIC  → MEDIA_PUBLIC bucket (logos, slides, gallery, accommodation, food, history, fonts)
--   PRIVATE → MEDIA_PRIVATE bucket (payment slips). Never served without authorization.

CREATE TABLE media_assets (
  id          TEXT PRIMARY KEY,
  bucket      TEXT NOT NULL CHECK (bucket IN ('PUBLIC', 'PRIVATE')),
  object_key  TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN (
                'LOGO', 'FAVICON', 'FONT', 'HOME_SLIDE', 'HOME_SECTION', 'GALLERY', 'HISTORY',
                'ACCOMMODATION', 'FOOD', 'PAYMENT_QR', 'PAYMENT_SLIP', 'OG_IMAGE', 'OTHER')),
  mime_type   TEXT NOT NULL CHECK (mime_type IN (
                'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/x-icon',
                'font/woff2', 'font/woff')),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes > 0),
  width       INTEGER CHECK (width IS NULL OR width > 0),
  height      INTEGER CHECK (height IS NULL OR height > 0),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
  uploaded_by TEXT REFERENCES users (id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at  TEXT,
  UNIQUE (bucket, object_key),
  -- Safe object keys only: no traversal, no leading slash, no schemes.
  CHECK (object_key GLOB '[A-Za-z0-9]*' AND object_key NOT GLOB '*..*'
         AND object_key NOT GLOB '*//*' AND object_key NOT GLOB '*[^A-Za-z0-9._/-]*'),
  -- Slips must be private, and only slips may be private.
  CHECK ((purpose = 'PAYMENT_SLIP') = (bucket = 'PRIVATE'))
) STRICT;

CREATE INDEX ix_media_assets_purpose ON media_assets (purpose, status);
CREATE INDEX ix_media_assets_sha256 ON media_assets (sha256);

-- Image SEO (spec §56): alt / title / caption per language.
CREATE TABLE media_asset_translations (
  media_asset_id TEXT NOT NULL REFERENCES media_assets (id),
  language_code  TEXT NOT NULL REFERENCES languages (code),
  alt_text       TEXT,
  title          TEXT,
  caption        TEXT,
  PRIMARY KEY (media_asset_id, language_code)
) STRICT;
