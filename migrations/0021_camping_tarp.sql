-- Migration 0021: camping add-on "tarp area" (extra space next to the tents for a tarp)
-- Non-destructive: three new columns on camping_settings (with defaults: option off, price 0, 0 areas
-- per night), a nightly tarp-area counter and a per-booking tarp snapshot (new tables), and guard
-- triggers. No existing row is changed.

-- ---------------------------------------------------------------------------
-- Settings (Admin → Accommodation → Camping). Price per tarp area per night; areas per night.
-- ---------------------------------------------------------------------------
ALTER TABLE camping_settings ADD COLUMN tarp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tarp_enabled IN (0, 1));
ALTER TABLE camping_settings ADD COLUMN tarp_price_per_night_satang INTEGER NOT NULL DEFAULT 0 CHECK (tarp_price_per_night_satang >= 0);
ALTER TABLE camping_settings ADD COLUMN max_tarps_per_night INTEGER NOT NULL DEFAULT 0 CHECK (max_tarps_per_night >= 0);

-- ---------------------------------------------------------------------------
-- Per-night tarp-area counter: same pattern as camping_night_inventory. Rows are created on demand
-- with the current default and incremented in the same D1 batch as the booking; the CHECK makes
-- overselling impossible under concurrent requests (the whole booking batch rolls back).
-- ---------------------------------------------------------------------------
CREATE TABLE camping_tarp_night_inventory (
  stay_date  TEXT PRIMARY KEY CHECK (date(stay_date) = stay_date),
  max_tarps  INTEGER NOT NULL CHECK (max_tarps >= 0),
  tarps_used INTEGER NOT NULL DEFAULT 0 CHECK (tarps_used >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (tarps_used <= max_tarps)
) STRICT;

-- ---------------------------------------------------------------------------
-- Tarp area of a booking: price snapshot taken at booking time (spec §17). The money fields never
-- change; only status follows the booking (ACTIVE → CANCELLED when it is cancelled / expires).
-- ---------------------------------------------------------------------------
CREATE TABLE booking_tarps (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL UNIQUE REFERENCES bookings (id),
  quantity               INTEGER NOT NULL CHECK (quantity >= 1),
  price_per_night_satang INTEGER NOT NULL CHECK (price_per_night_satang >= 0),
  number_of_nights       INTEGER NOT NULL CHECK (number_of_nights >= 1),
  subtotal_satang        INTEGER NOT NULL CHECK (subtotal_satang = quantity * price_per_night_satang * number_of_nights),
  status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  captured_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_booking_tarps_active ON booking_tarps (booking_id) WHERE status = 'ACTIVE';

CREATE TRIGGER trg_booking_tarps_snapshot_frozen
BEFORE UPDATE OF booking_id, quantity, price_per_night_satang, number_of_nights, subtotal_satang ON booking_tarps
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_booking_tarps_no_delete BEFORE DELETE ON booking_tarps
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

-- A tarp area belongs to an own-tent camping booking (the item is inserted first in the same batch).
CREATE TRIGGER trg_booking_tarps_camping_only BEFORE INSERT ON booking_tarps
WHEN NOT EXISTS (SELECT 1 FROM booking_items WHERE booking_id = NEW.booking_id AND item_type = 'OWN_TENT')
BEGIN
  SELECT RAISE(ABORT, 'TARP_NEEDS_CAMPING');
END;

-- ... and can only be booked while the owner offers it (closes the gap between price quote and booking).
CREATE TRIGGER trg_booking_tarps_enabled BEFORE INSERT ON booking_tarps
WHEN COALESCE((SELECT tarp_enabled FROM camping_settings WHERE id = 1), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'TARP_DISABLED');
END;
