-- Migration 0022: CHECK constraints that Cloudflare D1 cannot evaluate (table rebuild)
--
-- D1 limits a LIKE / GLOB pattern to 50 bytes ("LIKE or GLOB pattern too complex"). Three CHECKs used
-- longer patterns, so on D1 every booking insert failed, and so did home slides and a floating-button
-- colour. Local SQLite has no such limit, which is why tests did not see it.
--   bookings.booking_code             BK-YYYYMMDD-XXXX  → length / substr checks + two short GLOBs
--   home_slides.overlay_color          #RRGGBB          → length / substr + short GLOB
--   booking_cta_settings.color         #RRGGBB or NULL  → same
-- Same rules, same columns, indexes and triggers; nothing else changes.
--
-- DESTRUCTIVE (table rebuild: create new → copy → drop old → rename). Announced 2026-10-09.
--   Production at the time: all three tables were EMPTY (0 rows), so no data moves.
--   Backup / rollback: D1 Time Travel to a point before this migration (`wrangler d1 time-travel`).
--   Copies every column by name; foreign keys from other tables point at the table name and keep
--   working after the rename (deferred to commit where the runner uses a transaction).
PRAGMA defer_foreign_keys = true;

-- triggers on other tables that read the rebuilt tables (re-created at the end, unchanged)
DROP TRIGGER trg_booking_unit_nights_in_range;
DROP TRIGGER trg_payments_booking_live;

-- bookings
CREATE TABLE bookings__new (
  id                            TEXT PRIMARY KEY,
  booking_code                  TEXT NOT NULL UNIQUE
                                CHECK (length(booking_code) = 16 AND substr(booking_code, 1, 3) = 'BK-' AND substr(booking_code, 12, 1) = '-'
                                       AND substr(booking_code, 4, 8) NOT GLOB '*[^0-9]*' AND substr(booking_code, 13, 4) NOT GLOB '*[^A-Z0-9]*'),
  language_code                 TEXT NOT NULL REFERENCES languages (code),
  source                        TEXT NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB', 'ADMIN', 'PHONE', 'LINE', 'WALK_IN')),
  check_in                      TEXT NOT NULL CHECK (date(check_in) = check_in),
  check_out                     TEXT NOT NULL CHECK (date(check_out) = check_out),
  nights                        INTEGER NOT NULL CHECK (nights >= 1),
  adults                        INTEGER NOT NULL CHECK (adults >= 1),
  children                      INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  customer_name                 TEXT NOT NULL CHECK (length(trim(customer_name)) >= 1),
  customer_phone                TEXT NOT NULL,
  customer_phone_normalized     TEXT NOT NULL CHECK (customer_phone_normalized NOT GLOB '*[^0-9+]*'
                                                    AND length(customer_phone_normalized) BETWEEN 6 AND 16),
  customer_email                TEXT,
  customer_line_id              TEXT,
  customer_note                 TEXT,
  admin_note                    TEXT,
  booking_status                TEXT NOT NULL DEFAULT 'PENDING'
                                CHECK (booking_status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT',
                                                          'CANCELLED', 'EXPIRED', 'NO_SHOW')),
  payment_status                TEXT NOT NULL DEFAULT 'UNPAID'
                                CHECK (payment_status IN ('UNPAID', 'PENDING_VERIFICATION', 'VERIFIED', 'PAID',
                                                          'REJECTED', 'REFUNDED')),
  accommodation_subtotal_satang INTEGER NOT NULL CHECK (accommodation_subtotal_satang >= 0),
  food_subtotal_satang          INTEGER NOT NULL DEFAULT 0 CHECK (food_subtotal_satang >= 0),
  subtotal_satang               INTEGER NOT NULL CHECK (subtotal_satang >= 0),
  discount_satang               INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
  total_satang                  INTEGER NOT NULL CHECK (total_satang >= 0),
  currency                      TEXT NOT NULL DEFAULT 'THB' CHECK (length(currency) = 3),
  expires_at                    TEXT,
  confirmed_at                  TEXT,
  cancelled_at                  TEXT,
  cancelled_by                  TEXT REFERENCES users (id),
  cancel_reason                 TEXT,
  created_by                    TEXT REFERENCES users (id),
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), idempotency_key TEXT
  CHECK (idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 16 AND 64 AND idempotency_key NOT GLOB '*[^A-Za-z0-9-]*')), privacy_accepted_at TEXT,
  CHECK (check_out > check_in),
  CHECK (nights = CAST(julianday(check_out) - julianday(check_in) AS INTEGER)),
  CHECK (subtotal_satang = accommodation_subtotal_satang + food_subtotal_satang),
  CHECK (discount_satang <= subtotal_satang),
  CHECK (total_satang = subtotal_satang - discount_satang),
  CHECK ((booking_status = 'CANCELLED') = (cancelled_at IS NOT NULL))
) STRICT;
INSERT INTO bookings__new (id, booking_code, language_code, source, check_in, check_out, nights, adults, children, customer_name, customer_phone, customer_phone_normalized, customer_email, customer_line_id, customer_note, admin_note, booking_status, payment_status, accommodation_subtotal_satang, food_subtotal_satang, subtotal_satang, discount_satang, total_satang, currency, expires_at, confirmed_at, cancelled_at, cancelled_by, cancel_reason, created_by, created_at, updated_at, idempotency_key, privacy_accepted_at) SELECT id, booking_code, language_code, source, check_in, check_out, nights, adults, children, customer_name, customer_phone, customer_phone_normalized, customer_email, customer_line_id, customer_note, admin_note, booking_status, payment_status, accommodation_subtotal_satang, food_subtotal_satang, subtotal_satang, discount_satang, total_satang, currency, expires_at, confirmed_at, cancelled_at, cancelled_by, cancel_reason, created_by, created_at, updated_at, idempotency_key, privacy_accepted_at FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings__new RENAME TO bookings;
CREATE INDEX ix_bookings_check_in ON bookings (check_in);
CREATE INDEX ix_bookings_check_out ON bookings (check_out);
CREATE INDEX ix_bookings_confirmed ON bookings (confirmed_at) WHERE confirmed_at IS NOT NULL;
CREATE INDEX ix_bookings_created ON bookings (created_at);
CREATE INDEX ix_bookings_customer_phone ON bookings (customer_phone_normalized);
CREATE INDEX ix_bookings_expires ON bookings (expires_at) WHERE booking_status = 'PENDING';
CREATE INDEX ix_bookings_payment_status ON bookings (payment_status, created_at);
CREATE INDEX ix_bookings_status ON bookings (booking_status, check_in);
CREATE UNIQUE INDEX ux_bookings_idempotency_key ON bookings (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER trg_bookings_no_delete BEFORE DELETE ON bookings
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DELETE_FORBIDDEN');
END;
CREATE TRIGGER trg_bookings_status_transition BEFORE UPDATE OF booking_status ON bookings
WHEN NEW.booking_status <> OLD.booking_status
 AND NOT (
      (OLD.booking_status = 'PENDING'    AND NEW.booking_status IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
   OR (OLD.booking_status = 'CONFIRMED'  AND NEW.booking_status IN ('CHECKED_IN', 'CANCELLED', 'NO_SHOW'))
   OR (OLD.booking_status = 'CHECKED_IN' AND NEW.booking_status = 'CHECKED_OUT'))
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_STATUS_TRANSITION');
END;

-- home_slides
CREATE TABLE home_slides__new (
  id                     TEXT PRIMARY KEY,
  desktop_asset_id       TEXT NOT NULL REFERENCES media_assets (id),
  mobile_asset_id        TEXT REFERENCES media_assets (id),
  overlay_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (overlay_enabled IN (0, 1)),
  overlay_color          TEXT NOT NULL DEFAULT '#000000'
                         CHECK (length(overlay_color) = 7 AND substr(overlay_color, 1, 1) = '#' AND substr(overlay_color, 2) NOT GLOB '*[^0-9A-Fa-f]*'),
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
INSERT INTO home_slides__new (id, desktop_asset_id, mobile_asset_id, overlay_enabled, overlay_color, overlay_opacity, content_position, button1_url, button2_url, start_at, end_at, status, sort_order, created_by, created_at, updated_at) SELECT id, desktop_asset_id, mobile_asset_id, overlay_enabled, overlay_color, overlay_opacity, content_position, button1_url, button2_url, start_at, end_at, status, sort_order, created_by, created_at, updated_at FROM home_slides;
DROP TABLE home_slides;
ALTER TABLE home_slides__new RENAME TO home_slides;
CREATE INDEX ix_home_slides_desktop_asset ON home_slides (desktop_asset_id);
CREATE INDEX ix_home_slides_mobile_asset ON home_slides (mobile_asset_id) WHERE mobile_asset_id IS NOT NULL;
CREATE INDEX ix_home_slides_sort ON home_slides (sort_order);
CREATE INDEX ix_home_slides_status ON home_slides (status, sort_order);
CREATE INDEX ix_home_slides_window ON home_slides (start_at, end_at);

-- booking_cta_settings
CREATE TABLE booking_cta_settings__new (
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
  color            TEXT CHECK (color IS NULL OR (length(color) = 7 AND substr(color, 1, 1) = '#' AND substr(color, 2) NOT GLOB '*[^0-9A-Fa-f]*')),
  animation        TEXT NOT NULL DEFAULT 'NONE' CHECK (animation IN ('NONE', 'PULSE', 'BOUNCE', 'SLIDE_IN')),
  closeable        INTEGER NOT NULL DEFAULT 0 CHECK (closeable IN (0, 1)),
  target_path      TEXT NOT NULL DEFAULT '/{lang}/booking' CHECK (target_path GLOB '/*' AND target_path NOT GLOB '//*'),
  pages_json       TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(pages_json) AND json_type(pages_json) = 'array'),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by       TEXT REFERENCES users (id)
) STRICT;
INSERT INTO booking_cta_settings__new (id, enabled, show_on_desktop, show_on_mobile, desktop_position, mobile_position, size, icon, color, animation, closeable, target_path, pages_json, updated_at, updated_by) SELECT id, enabled, show_on_desktop, show_on_mobile, desktop_position, mobile_position, size, icon, color, animation, closeable, target_path, pages_json, updated_at, updated_by FROM booking_cta_settings;
DROP TABLE booking_cta_settings;
ALTER TABLE booking_cta_settings__new RENAME TO booking_cta_settings;

-- re-create the triggers dropped above
CREATE TRIGGER trg_booking_unit_nights_in_range BEFORE INSERT ON booking_unit_nights
WHEN NEW.booking_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM bookings b
                  WHERE b.id = NEW.booking_id AND NEW.stay_date >= b.check_in AND NEW.stay_date < b.check_out)
BEGIN
  SELECT RAISE(ABORT, 'STAY_NIGHT_OUT_OF_RANGE');
END;
CREATE TRIGGER trg_payments_booking_live BEFORE INSERT ON payments
WHEN (SELECT booking_status FROM bookings WHERE id = NEW.booking_id) IN ('CANCELLED', 'EXPIRED')
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_NOT_PAYABLE');
END;
PRAGMA defer_foreign_keys = false;
