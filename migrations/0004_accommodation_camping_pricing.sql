-- Migration 0004: accommodation inventory (houses, VIP tents), camping, pricing

-- ---------------------------------------------------------------------------
-- Individually bookable units: each house and each VIP tent is its own inventory.
-- ---------------------------------------------------------------------------
CREATE TABLE accommodation_units (
  id                TEXT PRIMARY KEY,
  unit_code         TEXT NOT NULL UNIQUE,            -- HOUSE-01, VIP-01
  unit_type         TEXT NOT NULL CHECK (unit_type IN ('HOUSE', 'VIP_TENT')),
  slug              TEXT NOT NULL UNIQUE CHECK (slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 1 AND 80),
  pricing_type      TEXT NOT NULL DEFAULT 'PER_UNIT_NIGHT' CHECK (pricing_type IN ('PER_UNIT_NIGHT')),
  base_price_satang INTEGER NOT NULL CHECK (base_price_satang >= 0),
  standard_guests   INTEGER NOT NULL CHECK (standard_guests >= 1),
  max_guests        INTEGER NOT NULL CHECK (max_guests >= 1),
  max_adults        INTEGER CHECK (max_adults IS NULL OR max_adults >= 1),
  cover_asset_id    TEXT REFERENCES media_assets (id),
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'MAINTENANCE', 'DELETED')),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT REFERENCES users (id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at        TEXT,
  CHECK (max_guests >= standard_guests),
  CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
) STRICT;

CREATE INDEX ix_accommodation_units_type_status ON accommodation_units (unit_type, status, sort_order);

CREATE TABLE accommodation_translations (
  unit_id           TEXT NOT NULL REFERENCES accommodation_units (id),
  language_code     TEXT NOT NULL REFERENCES languages (code),
  name              TEXT NOT NULL,
  short_description TEXT,
  description       TEXT,
  seo_title         TEXT,
  seo_description   TEXT,
  PRIMARY KEY (unit_id, language_code)
) STRICT;

CREATE TABLE accommodation_images (
  id             TEXT PRIMARY KEY,
  unit_id        TEXT NOT NULL REFERENCES accommodation_units (id),
  media_asset_id TEXT NOT NULL REFERENCES media_assets (id),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT', 'PUBLISHED', 'UNPUBLISHED')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (unit_id, media_asset_id)
) STRICT;

CREATE INDEX ix_accommodation_images_unit ON accommodation_images (unit_id, status, sort_order);

-- Amenity catalogue + many-to-many to units.
CREATE TABLE amenities (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE CHECK (code NOT GLOB '*[^a-z0-9_]*'),
  icon       TEXT CHECK (icon IS NULL OR icon NOT GLOB '*[^a-z0-9-]*'),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'))
) STRICT;

CREATE TABLE amenity_translations (
  amenity_id    TEXT NOT NULL REFERENCES amenities (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  name          TEXT NOT NULL,
  PRIMARY KEY (amenity_id, language_code)
) STRICT;

CREATE TABLE accommodation_amenities (
  unit_id    TEXT NOT NULL REFERENCES accommodation_units (id),
  amenity_id TEXT NOT NULL REFERENCES amenities (id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (unit_id, amenity_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- Camping — "bring your own tent" shared capacity (spec §12.3, §18)
-- ---------------------------------------------------------------------------
CREATE TABLE camping_settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  is_enabled                  INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  max_tents_per_night         INTEGER NOT NULL CHECK (max_tents_per_night >= 0),
  price_per_adult_night_satang INTEGER NOT NULL CHECK (price_per_adult_night_satang >= 0),
  child_free_under_age        INTEGER NOT NULL DEFAULT 12 CHECK (child_free_under_age BETWEEN 0 AND 18),
  max_guests_per_tent         INTEGER CHECK (max_guests_per_tent IS NULL OR max_guests_per_tent >= 1),
  cover_asset_id              TEXT REFERENCES media_assets (id),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by                  TEXT REFERENCES users (id)
) STRICT;

CREATE TABLE camping_setting_translations (
  language_code   TEXT PRIMARY KEY REFERENCES languages (code),
  name            TEXT NOT NULL,
  description     TEXT,
  seo_title       TEXT,
  seo_description TEXT
) STRICT;

-- Per-night tent counter. Rows are created on demand (INSERT OR IGNORE with the
-- current default capacity) and incremented in the same D1 batch as the booking.
-- The CHECK makes over-capacity impossible even under concurrent requests: the
-- whole batch (booking included) is rolled back. Admins can override a date by
-- changing max_tents; lowering it below tents_used is rejected by the CHECK.
CREATE TABLE camping_night_inventory (
  stay_date  TEXT PRIMARY KEY CHECK (date(stay_date) = stay_date),
  max_tents  INTEGER NOT NULL CHECK (max_tents >= 0),
  tents_used INTEGER NOT NULL DEFAULT 0 CHECK (tents_used >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (tents_used <= max_tents)
) STRICT;

-- ---------------------------------------------------------------------------
-- Pricing rules (seasonal / weekday overrides) and price history
-- ---------------------------------------------------------------------------
CREATE TABLE pricing_settings (
  id             TEXT PRIMARY KEY,
  target_type    TEXT NOT NULL CHECK (target_type IN ('UNIT', 'UNIT_TYPE', 'CAMPING')),
  unit_id        TEXT REFERENCES accommodation_units (id),
  unit_type      TEXT CHECK (unit_type IS NULL OR unit_type IN ('HOUSE', 'VIP_TENT')),
  name           TEXT NOT NULL,
  date_from      TEXT NOT NULL CHECK (date(date_from) = date_from),
  date_to        TEXT NOT NULL CHECK (date(date_to) = date_to),  -- inclusive stay date
  days_of_week   TEXT NOT NULL DEFAULT '0123456' CHECK (days_of_week NOT GLOB '*[^0-6]*' AND length(days_of_week) BETWEEN 1 AND 7),
  price_satang   INTEGER NOT NULL CHECK (price_satang >= 0),
  priority       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_by     TEXT REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (date_to >= date_from),
  CHECK ((target_type = 'UNIT') = (unit_id IS NOT NULL)),
  CHECK ((target_type = 'UNIT_TYPE') = (unit_type IS NOT NULL))
) STRICT;

CREATE INDEX ix_pricing_settings_lookup ON pricing_settings (target_type, status, date_from, date_to);
CREATE INDEX ix_pricing_settings_unit ON pricing_settings (unit_id);

CREATE TABLE price_history (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('UNIT', 'CAMPING', 'PRICING_RULE', 'FOOD_OPTION')),
  entity_id        TEXT NOT NULL,
  old_price_satang INTEGER,
  new_price_satang INTEGER,
  changed_by       TEXT REFERENCES users (id),
  changed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reason           TEXT
) STRICT;

CREATE INDEX ix_price_history_entity ON price_history (entity_type, entity_id, changed_at);

CREATE TRIGGER trg_price_history_no_update BEFORE UPDATE ON price_history
BEGIN
  SELECT RAISE(ABORT, 'PRICE_HISTORY_IMMUTABLE');
END;

CREATE TRIGGER trg_price_history_no_delete BEFORE DELETE ON price_history
BEGIN
  SELECT RAISE(ABORT, 'PRICE_HISTORY_IMMUTABLE');
END;
