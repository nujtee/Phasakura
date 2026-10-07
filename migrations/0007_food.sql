-- Migration 0007: food module (menu, included meals, extra food, daily capacity, kitchen orders)

CREATE TABLE food_categories (
  id                     TEXT PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE CHECK (code NOT GLOB '*[^A-Z_]*'),  -- BREAKFAST, DINNER, BBQ, OTHER, LUNCH, …
  default_daily_capacity INTEGER CHECK (default_daily_capacity IS NULL OR default_daily_capacity >= 0), -- NULL = unlimited
  deadline_type          TEXT NOT NULL DEFAULT 'NONE'
                         CHECK (deadline_type IN ('NONE', 'DAYS_BEFORE', 'PREVIOUS_DAY_TIME')),
  deadline_days_before   INTEGER CHECK (deadline_days_before IS NULL OR deadline_days_before >= 0),
  deadline_time          TEXT CHECK (deadline_time IS NULL OR deadline_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  service_time           TEXT CHECK (service_time IS NULL OR service_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  sort_order             INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CHECK (deadline_type <> 'DAYS_BEFORE' OR deadline_days_before IS NOT NULL),
  CHECK (deadline_type <> 'PREVIOUS_DAY_TIME' OR deadline_time IS NOT NULL)
) STRICT;

CREATE TABLE food_category_translations (
  food_category_id TEXT NOT NULL REFERENCES food_categories (id),
  language_code    TEXT NOT NULL REFERENCES languages (code),
  name             TEXT NOT NULL,
  description      TEXT,
  PRIMARY KEY (food_category_id, language_code)
) STRICT;

CREATE TABLE food_options (
  id                 TEXT PRIMARY KEY,
  food_category_id   TEXT NOT NULL REFERENCES food_categories (id),
  code               TEXT NOT NULL UNIQUE,
  pricing_type       TEXT NOT NULL CHECK (pricing_type IN ('PER_PERSON', 'PER_SET', 'PER_ITEM', 'PER_NIGHT')),
  price_satang       INTEGER NOT NULL CHECK (price_satang >= 0),
  child_pricing      TEXT NOT NULL DEFAULT 'FULL' CHECK (child_pricing IN ('FREE', 'FULL', 'HALF', 'SPECIAL_PRICE')),
  child_price_satang INTEGER CHECK (child_price_satang IS NULL OR child_price_satang >= 0),
  persons_per_set    INTEGER CHECK (persons_per_set IS NULL OR persons_per_set >= 1),
  min_quantity       INTEGER NOT NULL DEFAULT 1 CHECK (min_quantity >= 1),
  max_quantity       INTEGER CHECK (max_quantity IS NULL OR max_quantity >= 1),
  status             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'DELETED')),
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_by         TEXT REFERENCES users (id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((child_pricing = 'SPECIAL_PRICE') = (child_price_satang IS NOT NULL)),
  CHECK (max_quantity IS NULL OR max_quantity >= min_quantity)
) STRICT;

CREATE INDEX ix_food_options_category ON food_options (food_category_id, status, sort_order);

CREATE TABLE food_option_translations (
  food_option_id TEXT NOT NULL REFERENCES food_options (id),
  language_code  TEXT NOT NULL REFERENCES languages (code),
  name           TEXT NOT NULL,
  description    TEXT,
  allergens      TEXT,
  PRIMARY KEY (food_option_id, language_code)
) STRICT;

CREATE TABLE food_images (
  id             TEXT PRIMARY KEY,
  food_option_id TEXT NOT NULL REFERENCES food_options (id),
  media_asset_id TEXT NOT NULL REFERENCES media_assets (id),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_cover       INTEGER NOT NULL DEFAULT 0 CHECK (is_cover IN (0, 1)),
  UNIQUE (food_option_id, media_asset_id)
) STRICT;

CREATE UNIQUE INDEX ux_food_images_single_cover ON food_images (food_option_id) WHERE is_cover = 1;

-- Meals included with an accommodation (e.g. House Sakura: breakfast for 2 persons/night).
CREATE TABLE included_meals (
  id                TEXT PRIMARY KEY,
  target_type       TEXT NOT NULL CHECK (target_type IN ('UNIT', 'UNIT_TYPE', 'CAMPING')),
  unit_id           TEXT REFERENCES accommodation_units (id),
  unit_type         TEXT CHECK (unit_type IS NULL OR unit_type IN ('HOUSE', 'VIP_TENT')),
  food_category_id  TEXT NOT NULL REFERENCES food_categories (id),
  food_option_id    TEXT REFERENCES food_options (id),     -- NULL = guest picks any option in the category
  persons_per_night INTEGER NOT NULL CHECK (persons_per_night >= 1),
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((target_type = 'UNIT') = (unit_id IS NOT NULL)),
  CHECK ((target_type = 'UNIT_TYPE') = (unit_type IS NOT NULL))
) STRICT;

CREATE INDEX ix_included_meals_unit ON included_meals (unit_id, status);

-- Snapshot of included meals at booking time (spec §20). Immutable.
CREATE TABLE booking_included_meals (
  id                         TEXT PRIMARY KEY,
  booking_id                 TEXT NOT NULL REFERENCES bookings (id),
  booking_item_id            TEXT NOT NULL REFERENCES booking_items (id),
  included_meal_id           TEXT REFERENCES included_meals (id),
  food_category_id           TEXT NOT NULL REFERENCES food_categories (id),
  food_option_id             TEXT REFERENCES food_options (id),
  meal_name_snapshot         TEXT NOT NULL,
  persons_per_night_snapshot INTEGER NOT NULL CHECK (persons_per_night_snapshot >= 1),
  number_of_nights           INTEGER NOT NULL CHECK (number_of_nights >= 1),
  captured_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_booking_included_meals_booking ON booking_included_meals (booking_id);

CREATE TRIGGER trg_booking_included_meals_no_update BEFORE UPDATE ON booking_included_meals
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_booking_included_meals_no_delete BEFORE DELETE ON booking_included_meals
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

-- Daily capacity per meal category (spec §22). Same pattern as camping:
-- create row on demand, increment in the booking batch, CHECK rejects overflow.
CREATE TABLE food_daily_capacity (
  food_category_id TEXT NOT NULL REFERENCES food_categories (id),
  service_date     TEXT NOT NULL CHECK (date(service_date) = service_date),
  max_quantity     INTEGER NOT NULL CHECK (max_quantity >= 0),
  used_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (used_quantity >= 0),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (food_category_id, service_date),
  CHECK (used_quantity <= max_quantity)
) STRICT;

CREATE INDEX ix_food_daily_capacity_date ON food_daily_capacity (service_date);

-- Kitchen order: one per booking × meal category × service date.
CREATE TABLE food_orders (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL REFERENCES bookings (id),
  food_category_id TEXT NOT NULL REFERENCES food_categories (id),
  service_date     TEXT NOT NULL CHECK (date(service_date) = service_date),
  status           TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED')),
  total_persons    INTEGER NOT NULL DEFAULT 0 CHECK (total_persons >= 0),
  kitchen_note     TEXT,
  status_changed_at TEXT,
  status_changed_by TEXT REFERENCES users (id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (booking_id, food_category_id, service_date)
) STRICT;

CREATE INDEX ix_food_orders_service ON food_orders (service_date, food_category_id, status);

-- Food lines on a booking (included and extra). Price fields are snapshots.
CREATE TABLE booking_food_items (
  id                          TEXT PRIMARY KEY,
  booking_id                  TEXT NOT NULL REFERENCES bookings (id),
  food_order_id               TEXT REFERENCES food_orders (id),
  food_option_id              TEXT NOT NULL REFERENCES food_options (id),
  service_date                TEXT NOT NULL CHECK (date(service_date) = service_date),
  option_name_snapshot        TEXT NOT NULL,
  category_code_snapshot      TEXT NOT NULL,
  pricing_type_snapshot       TEXT NOT NULL CHECK (pricing_type_snapshot IN ('PER_PERSON', 'PER_SET', 'PER_ITEM', 'PER_NIGHT')),
  unit_price_snapshot_satang  INTEGER NOT NULL CHECK (unit_price_snapshot_satang >= 0),
  child_pricing_snapshot      TEXT NOT NULL CHECK (child_pricing_snapshot IN ('FREE', 'FULL', 'HALF', 'SPECIAL_PRICE')),
  child_price_snapshot_satang INTEGER CHECK (child_price_snapshot_satang IS NULL OR child_price_snapshot_satang >= 0),
  adults                      INTEGER NOT NULL DEFAULT 0 CHECK (adults >= 0),
  children                    INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  quantity                    INTEGER NOT NULL CHECK (quantity >= 1),
  included_quantity           INTEGER NOT NULL DEFAULT 0 CHECK (included_quantity >= 0),
  subtotal_satang             INTEGER NOT NULL CHECK (subtotal_satang >= 0),
  status                      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (included_quantity <= quantity)
) STRICT;

CREATE INDEX ix_booking_food_items_booking ON booking_food_items (booking_id);
CREATE INDEX ix_booking_food_items_service ON booking_food_items (service_date, food_option_id);

-- Only status / order link may change after creation; money fields are frozen.
CREATE TRIGGER trg_booking_food_items_price_frozen BEFORE UPDATE ON booking_food_items
WHEN NEW.unit_price_snapshot_satang IS NOT OLD.unit_price_snapshot_satang
  OR NEW.child_price_snapshot_satang IS NOT OLD.child_price_snapshot_satang
  OR NEW.child_pricing_snapshot IS NOT OLD.child_pricing_snapshot
  OR NEW.pricing_type_snapshot IS NOT OLD.pricing_type_snapshot
  OR NEW.subtotal_satang IS NOT OLD.subtotal_satang
  OR NEW.quantity IS NOT OLD.quantity
  OR NEW.included_quantity IS NOT OLD.included_quantity
  OR NEW.option_name_snapshot IS NOT OLD.option_name_snapshot
  OR NEW.booking_id IS NOT OLD.booking_id
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;
