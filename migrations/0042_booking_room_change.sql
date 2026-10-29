-- Migration 0042: change the room when moving a stay (Admin → booking → Change dates). Non-destructive: one nullable
-- column and one trigger.
--
-- When the booked house / VIP tent is not free on the new dates, staff may move the stay to another free unit of the
-- same type. booking_items.unit_id then names the room the guest now has, and unit_name its name (in the booking's
-- language); the price snapshot keeps what was sold (room, name, price) and is never changed.

ALTER TABLE booking_items ADD COLUMN unit_name TEXT CHECK (unit_name IS NULL OR length(unit_name) BETWEEN 1 AND 200);

-- Another room only of the same type, only one that can be booked.
CREATE TRIGGER trg_booking_items_unit_change BEFORE UPDATE OF unit_id ON booking_items
WHEN NEW.unit_id IS NOT OLD.unit_id
 AND (OLD.unit_id IS NULL OR NEW.unit_id IS NULL
      OR NEW.item_type <> COALESCE((SELECT unit_type FROM accommodation_units WHERE id = NEW.unit_id), '')
      OR COALESCE((SELECT status FROM accommodation_units WHERE id = NEW.unit_id), '') <> 'ACTIVE')
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_ITEM_UNIT_CHANGE_INVALID');
END;
