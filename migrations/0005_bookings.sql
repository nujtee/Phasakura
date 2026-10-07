-- Migration 0005: bookings, booking items, inventory night-locks, guests, price snapshots
--
-- Double-booking protection (spec §16) is enforced by the DATABASE:
--   booking_unit_nights has PRIMARY KEY (unit_id, stay_date). A booking inserts one
--   row per stay night in the same atomic D1 batch as the booking itself. If any
--   night is already taken the batch fails and nothing is written.
--   Check-out day is not a stay night (spec §15).

CREATE TABLE bookings (
  id                            TEXT PRIMARY KEY,
  booking_code                  TEXT NOT NULL UNIQUE
                                CHECK (booking_code GLOB 'BK-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'),
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
  expires_at                    TEXT,              -- unpaid hold expiry
  confirmed_at                  TEXT,
  cancelled_at                  TEXT,
  cancelled_by                  TEXT REFERENCES users (id),
  cancel_reason                 TEXT,
  created_by                    TEXT REFERENCES users (id),   -- NULL for public web bookings
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (check_out > check_in),
  CHECK (nights = CAST(julianday(check_out) - julianday(check_in) AS INTEGER)),
  CHECK (subtotal_satang = accommodation_subtotal_satang + food_subtotal_satang),
  CHECK (discount_satang <= subtotal_satang),
  CHECK (total_satang = subtotal_satang - discount_satang),
  CHECK ((booking_status = 'CANCELLED') = (cancelled_at IS NOT NULL))
) STRICT;

CREATE INDEX ix_bookings_check_in ON bookings (check_in);
CREATE INDEX ix_bookings_check_out ON bookings (check_out);
CREATE INDEX ix_bookings_status ON bookings (booking_status, check_in);
CREATE INDEX ix_bookings_payment_status ON bookings (payment_status, created_at);
CREATE INDEX ix_bookings_customer_phone ON bookings (customer_phone_normalized);
CREATE INDEX ix_bookings_created ON bookings (created_at);
CREATE INDEX ix_bookings_expires ON bookings (expires_at) WHERE booking_status = 'PENDING';

-- One row per booked product: a house, a VIP tent, or own-tent camping.
CREATE TABLE booking_items (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  item_type  TEXT NOT NULL CHECK (item_type IN ('HOUSE', 'VIP_TENT', 'OWN_TENT')),
  unit_id    TEXT REFERENCES accommodation_units (id),
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),   -- tents for OWN_TENT, 1 for units
  adults     INTEGER NOT NULL CHECK (adults >= 0),
  children   INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((item_type = 'OWN_TENT') = (unit_id IS NULL)),
  CHECK (item_type = 'OWN_TENT' OR quantity = 1)
) STRICT;

CREATE INDEX ix_booking_items_booking ON booking_items (booking_id);
CREATE INDEX ix_booking_items_unit ON booking_items (unit_id);

-- A unit item must match the unit's type (a HOUSE item cannot reference a VIP tent).
CREATE TRIGGER trg_booking_items_unit_type BEFORE INSERT ON booking_items
WHEN NEW.unit_id IS NOT NULL
 AND NEW.item_type <> (SELECT unit_type FROM accommodation_units WHERE id = NEW.unit_id)
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_ITEM_UNIT_TYPE_MISMATCH');
END;

-- Inventory night-locks: the database-level guarantee against double booking.
-- booking_id NULL + block_reason = admin block (maintenance, private use).
CREATE TABLE booking_unit_nights (
  unit_id         TEXT NOT NULL REFERENCES accommodation_units (id),
  stay_date       TEXT NOT NULL CHECK (date(stay_date) = stay_date),
  booking_id      TEXT REFERENCES bookings (id),
  booking_item_id TEXT REFERENCES booking_items (id),
  block_reason    TEXT,
  created_by      TEXT REFERENCES users (id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (unit_id, stay_date),
  CHECK ((booking_id IS NULL) = (block_reason IS NOT NULL)),
  CHECK ((booking_id IS NULL) = (booking_item_id IS NULL))
) STRICT;

CREATE INDEX ix_booking_unit_nights_date ON booking_unit_nights (stay_date);
CREATE INDEX ix_booking_unit_nights_booking ON booking_unit_nights (booking_id);

-- A night-lock must fall inside its booking's stay (check_in <= night < check_out).
CREATE TRIGGER trg_booking_unit_nights_in_range BEFORE INSERT ON booking_unit_nights
WHEN NEW.booking_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM bookings b
                  WHERE b.id = NEW.booking_id AND NEW.stay_date >= b.check_in AND NEW.stay_date < b.check_out)
BEGIN
  SELECT RAISE(ABORT, 'STAY_NIGHT_OUT_OF_RANGE');
END;

CREATE TABLE booking_guests (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  full_name  TEXT NOT NULL,
  guest_type TEXT NOT NULL CHECK (guest_type IN ('ADULT', 'CHILD')),
  age        INTEGER CHECK (age IS NULL OR age BETWEEN 0 AND 120),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_booking_guests_booking ON booking_guests (booking_id);

-- Price snapshot per booking item (spec §17). Immutable: later price changes
-- never alter an existing booking.
CREATE TABLE booking_price_snapshots (
  id                    TEXT PRIMARY KEY,
  booking_id            TEXT NOT NULL REFERENCES bookings (id),
  booking_item_id       TEXT NOT NULL UNIQUE REFERENCES booking_items (id),
  unit_id               TEXT REFERENCES accommodation_units (id),
  unit_name_snapshot    TEXT NOT NULL,
  unit_type             TEXT NOT NULL CHECK (unit_type IN ('HOUSE', 'VIP_TENT', 'OWN_TENT')),
  price_snapshot_satang INTEGER NOT NULL CHECK (price_snapshot_satang >= 0),
  pricing_type          TEXT NOT NULL CHECK (pricing_type IN ('PER_UNIT_NIGHT', 'PER_ADULT_NIGHT')),
  quantity              INTEGER NOT NULL CHECK (quantity >= 1),
  number_of_nights      INTEGER NOT NULL CHECK (number_of_nights >= 1),
  adult_count           INTEGER NOT NULL CHECK (adult_count >= 0),
  child_count           INTEGER NOT NULL CHECK (child_count >= 0),
  nightly_prices_json   TEXT CHECK (nightly_prices_json IS NULL OR json_valid(nightly_prices_json)),
  subtotal_satang       INTEGER NOT NULL CHECK (subtotal_satang >= 0),
  discount_satang       INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
  total_satang          INTEGER NOT NULL CHECK (total_satang >= 0),
  captured_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (total_satang = subtotal_satang - discount_satang),
  CHECK (discount_satang <= subtotal_satang)
) STRICT;

CREATE INDEX ix_booking_price_snapshots_booking ON booking_price_snapshots (booking_id);

CREATE TRIGGER trg_booking_price_snapshots_no_update BEFORE UPDATE ON booking_price_snapshots
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_booking_price_snapshots_no_delete BEFORE DELETE ON booking_price_snapshots
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

-- Bookings are business records: never hard-deleted (cancel instead).
CREATE TRIGGER trg_bookings_no_delete BEFORE DELETE ON bookings
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DELETE_FORBIDDEN');
END;
