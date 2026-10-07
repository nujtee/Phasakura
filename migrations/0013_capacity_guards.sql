-- Migration 0013: capacity guards (non-destructive: new triggers and an index only)
--
-- The booking batch already rejects overselling through CHECK constraints. These triggers
-- close the remaining time-of-check/time-of-use gaps between the price quote and the
-- atomic booking batch: if the owner closes camping or takes a unit out of service in
-- between, the database itself refuses the booking (the whole batch rolls back).

-- Own-tent camping can only be booked while camping is enabled.
CREATE TRIGGER trg_booking_items_camping_enabled BEFORE INSERT ON booking_items
WHEN NEW.item_type = 'OWN_TENT'
 AND COALESCE((SELECT is_enabled FROM camping_settings WHERE id = 1), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'CAMPING_DISABLED');
END;

-- A house / VIP tent can only be booked while it is ACTIVE (not DRAFT, INACTIVE, MAINTENANCE, DELETED).
CREATE TRIGGER trg_booking_items_unit_active BEFORE INSERT ON booking_items
WHEN NEW.unit_id IS NOT NULL
 AND COALESCE((SELECT status FROM accommodation_units WHERE id = NEW.unit_id), '') <> 'ACTIVE'
BEGIN
  SELECT RAISE(ABORT, 'UNIT_NOT_BOOKABLE');
END;

-- Integrity check / recalculation: active own-tent items by booking.
CREATE INDEX ix_booking_items_own_tent_active ON booking_items (booking_id) WHERE item_type = 'OWN_TENT' AND status = 'ACTIVE';
