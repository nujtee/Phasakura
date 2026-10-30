-- Migration 0043: extra beds (ที่นอนเสริม) for a house / VIP tent, chosen by the guest on the booking page.
-- Non-destructive: one settings table (one row, option off), one per-stay snapshot table and guard triggers.
-- No existing row or table changes.
--
-- The owner switches the option on and sets a price per bed per night and how many beds one house / VIP tent
-- can take (Admin → Accommodation → Houses). The money is part of the stay (accommodation subtotal, and of its
-- deposit on a deposit plan). A bed belongs to its stay: it follows the stay's status (booking_items.status), so a
-- cancelled / expired booking or a stay cancelled alone takes its beds with it, and a reinstated booking brings
-- them back — nothing to update here.

CREATE TABLE extra_bed_settings (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  is_enabled             INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  price_per_night_satang INTEGER NOT NULL DEFAULT 0 CHECK (price_per_night_satang >= 0 AND price_per_night_satang <= 10000000),
  max_per_unit           INTEGER NOT NULL DEFAULT 1 CHECK (max_per_unit BETWEEN 1 AND 10),
  updated_by             TEXT,
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO extra_bed_settings (id) VALUES (1);

-- Extra beds of one stay: price snapshot taken at booking time; never changes afterwards.
CREATE TABLE booking_extra_beds (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL REFERENCES bookings (id),
  booking_item_id        TEXT NOT NULL UNIQUE REFERENCES booking_items (id),
  quantity               INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  price_per_night_satang INTEGER NOT NULL CHECK (price_per_night_satang >= 0),
  number_of_nights       INTEGER NOT NULL CHECK (number_of_nights >= 1),
  subtotal_satang        INTEGER NOT NULL CHECK (subtotal_satang = quantity * price_per_night_satang * number_of_nights),
  captured_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_booking_extra_beds_booking ON booking_extra_beds (booking_id);

CREATE TRIGGER trg_booking_extra_beds_frozen BEFORE UPDATE ON booking_extra_beds
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_booking_extra_beds_no_delete BEFORE DELETE ON booking_extra_beds
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

-- Only a house / VIP tent of the same booking (the item is inserted first in the same batch), only while offered,
-- and never more beds than one unit may take.
CREATE TRIGGER trg_booking_extra_beds_check BEFORE INSERT ON booking_extra_beds
WHEN NOT EXISTS (SELECT 1 FROM booking_items WHERE id = NEW.booking_item_id AND booking_id = NEW.booking_id AND item_type IN ('HOUSE', 'VIP_TENT'))
  OR COALESCE((SELECT is_enabled FROM extra_bed_settings WHERE id = 1), 0) <> 1
  OR NEW.quantity > COALESCE((SELECT max_per_unit FROM extra_bed_settings WHERE id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'EXTRA_BED_UNAVAILABLE');
END;
