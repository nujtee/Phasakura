-- Migration 0047: extra beds per house (ที่นอนเสริม เปิด/ปิดทีละบ้าน).
-- Non-destructive: one new table listing the houses / VIP tents where extra beds are switched OFF (empty = every
-- house takes them while the option is on, as before), and the guard trigger of 0043 rebuilt to refuse those houses.
-- Bookings already made keep their beds.

CREATE TABLE extra_bed_unit_off (
  unit_id    TEXT PRIMARY KEY REFERENCES accommodation_units (id),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

DROP TRIGGER trg_booking_extra_beds_check;

-- Only a house / VIP tent of the same booking (the item is inserted first in the same batch), only while offered,
-- never in a house where it is switched off, and never more beds than one unit may take.
CREATE TRIGGER trg_booking_extra_beds_check BEFORE INSERT ON booking_extra_beds
WHEN NOT EXISTS (SELECT 1 FROM booking_items WHERE id = NEW.booking_item_id AND booking_id = NEW.booking_id AND item_type IN ('HOUSE', 'VIP_TENT'))
  OR COALESCE((SELECT is_enabled FROM extra_bed_settings WHERE id = 1), 0) <> 1
  OR NEW.quantity > COALESCE((SELECT max_per_unit FROM extra_bed_settings WHERE id = 1), 0)
  OR EXISTS (SELECT 1 FROM booking_items i JOIN extra_bed_unit_off o ON o.unit_id = i.unit_id WHERE i.id = NEW.booking_item_id)
BEGIN
  SELECT RAISE(ABORT, 'EXTRA_BED_UNAVAILABLE');
END;
