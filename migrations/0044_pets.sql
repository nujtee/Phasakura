-- Migration 0044: pets (ค่านำสัตว์เลี้ยงเข้าที่พัก) for a house / VIP tent, chosen by the guest on the booking page.
-- Non-destructive: one settings table (one row, option off), one per-stay snapshot table and guard triggers.
-- No existing row or table changes. Same pattern as extra beds (0043): the pets follow their stay's status.
--
-- The owner switches the option on, sets the price (per pet per night, or per pet per stay), the heaviest pet
-- allowed (kg, told to the guest) and how many pets one house / VIP tent takes. The money is part of the stay
-- (accommodation subtotal, and of its deposit on a deposit plan).

CREATE TABLE pet_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  is_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  price_satang   INTEGER NOT NULL DEFAULT 0 CHECK (price_satang >= 0 AND price_satang <= 10000000),
  charge_per     TEXT NOT NULL DEFAULT 'NIGHT' CHECK (charge_per IN ('NIGHT', 'STAY')),
  max_weight_kg  INTEGER NOT NULL DEFAULT 10 CHECK (max_weight_kg BETWEEN 1 AND 200),
  max_per_unit   INTEGER NOT NULL DEFAULT 2 CHECK (max_per_unit BETWEEN 1 AND 10),
  updated_by     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO pet_settings (id) VALUES (1);

-- Pets of one stay: price snapshot taken at booking time; never changes afterwards.
-- charged_units = nights (per night) or 1 (per stay).
CREATE TABLE booking_pets (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL REFERENCES bookings (id),
  booking_item_id  TEXT NOT NULL UNIQUE REFERENCES booking_items (id),
  quantity         INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  price_satang     INTEGER NOT NULL CHECK (price_satang >= 0),
  charge_per       TEXT NOT NULL CHECK (charge_per IN ('NIGHT', 'STAY')),
  charged_units    INTEGER NOT NULL CHECK (charged_units >= 1),
  max_weight_kg    INTEGER NOT NULL CHECK (max_weight_kg BETWEEN 1 AND 200),
  subtotal_satang  INTEGER NOT NULL CHECK (subtotal_satang = quantity * price_satang * charged_units),
  captured_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_booking_pets_booking ON booking_pets (booking_id);

CREATE TRIGGER trg_booking_pets_frozen BEFORE UPDATE ON booking_pets
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_booking_pets_no_delete BEFORE DELETE ON booking_pets
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_booking_pets_check BEFORE INSERT ON booking_pets
WHEN NOT EXISTS (SELECT 1 FROM booking_items WHERE id = NEW.booking_item_id AND booking_id = NEW.booking_id AND item_type IN ('HOUSE', 'VIP_TENT'))
  OR COALESCE((SELECT is_enabled FROM pet_settings WHERE id = 1), 0) <> 1
  OR NEW.quantity > COALESCE((SELECT max_per_unit FROM pet_settings WHERE id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'PET_UNAVAILABLE');
END;
