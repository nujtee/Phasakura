-- Migration 0017: responsive image variants, food images, uploaded fonts (Phase 12)
-- Non-destructive: ADD COLUMN (nullable), one new table, triggers and indexes. No table rebuild, no data change.

-- ---------------------------------------------------------------------------
-- Responsive variants: smaller renditions of an image are media_assets rows that
-- point at their original (same bucket, same purpose). They are served and retired
-- together with it, and are never referenced by content directly.
-- ---------------------------------------------------------------------------
ALTER TABLE media_assets ADD COLUMN parent_asset_id TEXT REFERENCES media_assets (id);

CREATE INDEX ix_media_assets_parent ON media_assets (parent_asset_id) WHERE parent_asset_id IS NOT NULL;

CREATE TRIGGER trg_media_assets_variant_valid BEFORE INSERT ON media_assets
WHEN NEW.parent_asset_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM media_assets p
                  WHERE p.id = NEW.parent_asset_id AND p.parent_asset_id IS NULL AND p.status = 'ACTIVE'
                    AND p.bucket = NEW.bucket AND p.purpose = NEW.purpose
                    AND NEW.mime_type LIKE 'image/%' AND p.mime_type LIKE 'image/%')
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_VARIANT_INVALID');
END;

-- Font files are only stored as FONT assets, and FONT assets are only font files.
CREATE TRIGGER trg_media_assets_font_type BEFORE INSERT ON media_assets
WHEN (NEW.purpose = 'FONT') <> (NEW.mime_type IN ('font/woff2', 'font/woff'))
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_TYPE_PURPOSE');
END;

-- ---------------------------------------------------------------------------
-- Food images (spec §54): one picture per dish, edited with the menu.
-- (food_images from 0007 stays available for a multi-photo gallery later.)
-- ---------------------------------------------------------------------------
ALTER TABLE food_options ADD COLUMN image_asset_id TEXT REFERENCES media_assets (id);

-- ---------------------------------------------------------------------------
-- Uploaded web fonts (spec §37, §54): WOFF2 / WOFF files in R2, one row per face.
-- The theme refers to a family by name; the public site loads only the faces of
-- the families the published theme uses.
-- ---------------------------------------------------------------------------
CREATE TABLE custom_fonts (
  id             TEXT PRIMARY KEY,
  family         TEXT NOT NULL CHECK (length(family) BETWEEN 1 AND 40 AND family GLOB '[A-Za-z0-9]*'
                                      AND family NOT GLOB '*[^A-Za-z0-9 _-]*'),
  weight         INTEGER NOT NULL DEFAULT 400 CHECK (weight BETWEEN 100 AND 900 AND weight % 100 = 0),
  style          TEXT NOT NULL DEFAULT 'normal' CHECK (style IN ('normal', 'italic')),
  fallback       TEXT NOT NULL DEFAULT 'SANS' CHECK (fallback IN ('SANS', 'ROUNDED', 'SERIF', 'MONO')),
  media_asset_id TEXT NOT NULL UNIQUE REFERENCES media_assets (id),
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users (id),
  UNIQUE (family, weight, style)
) STRICT;

-- A font row must point at an active FONT file in the public bucket.
CREATE TRIGGER trg_custom_fonts_asset BEFORE INSERT ON custom_fonts
WHEN NOT EXISTS (SELECT 1 FROM media_assets m
                  WHERE m.id = NEW.media_asset_id AND m.purpose = 'FONT' AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE')
BEGIN
  SELECT RAISE(ABORT, 'FONT_ASSET_INVALID');
END;

-- ---------------------------------------------------------------------------
-- Lookups by media asset (public media access control, Phase 12).
-- ---------------------------------------------------------------------------
CREATE INDEX ix_gallery_images_asset ON gallery_images (media_asset_id);
CREATE INDEX ix_accommodation_images_asset ON accommodation_images (media_asset_id);
CREATE INDEX ix_accommodation_units_cover ON accommodation_units (cover_asset_id) WHERE cover_asset_id IS NOT NULL;
CREATE INDEX ix_home_slides_desktop_asset ON home_slides (desktop_asset_id);
CREATE INDEX ix_home_slides_mobile_asset ON home_slides (mobile_asset_id) WHERE mobile_asset_id IS NOT NULL;
CREATE INDEX ix_home_sections_asset ON home_sections (media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX ix_history_sections_asset ON history_sections (media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX ix_history_timeline_asset ON history_timeline (media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX ix_food_options_image ON food_options (image_asset_id) WHERE image_asset_id IS NOT NULL;
