-- Migration 0059: a guest adds stays to their own booking before paying ("จองเพิ่ม" on the confirmation page).
-- The added stays join the same booking (same Booking ID, guest details and dates); the total, deposit and app fee
-- grow with them. Non-destructive: one empty helper table and two replaced triggers; no data changes.

-- 1. Batch guard: a batch that must stop when the booking changed meanwhile inserts a row here only when its
--    condition fails; the insert always aborts, so the whole batch (D1 runs it as one transaction) is rolled back.
--    Nothing is ever stored in this table.
CREATE TABLE batch_guards (
  reason TEXT NOT NULL
) STRICT;

CREATE TRIGGER trg_batch_guards_abort BEFORE INSERT ON batch_guards
BEGIN
  SELECT RAISE(ABORT, 'BATCH_GUARD');
END;

-- 2. App fee (migration 0027). Lowering it is unchanged: only while the credits are still held (staff cancel one
--    stay of an unpaid booking). Raising it is new: only while the booking is still PENDING (a stay added before
--    paying) and only when the free credit covers the extra; a booking whose credits were already captured or
--    released is frozen as before.
DROP TRIGGER trg_bookings_app_fee_change;
CREATE TRIGGER trg_bookings_app_fee_change BEFORE UPDATE OF app_fee_satang, app_fee_units ON bookings
WHEN NEW.app_fee_satang <> OLD.app_fee_satang OR NEW.app_fee_units <> OLD.app_fee_units
BEGIN
  SELECT RAISE(ABORT, 'APP_FEE_FROZEN')
   WHERE NEW.app_fee_satang <= OLD.app_fee_satang
     AND (NOT EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id AND status = 'HELD') OR NEW.app_fee_units < 1);
  SELECT RAISE(ABORT, 'APP_FEE_FROZEN')
   WHERE NEW.app_fee_satang > OLD.app_fee_satang
     AND (OLD.booking_status <> 'PENDING' OR NEW.app_fee_units < 1
          OR EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id AND status <> 'HELD'));
  SELECT RAISE(ABORT, 'CREDIT_INSUFFICIENT')
   WHERE NEW.app_fee_satang > OLD.app_fee_satang
     AND COALESCE((SELECT balance - held FROM credit_account WHERE id = 1), 0) < NEW.app_fee_satang / 100 - OLD.app_fee_satang / 100;
END;

-- The hold follows the fee; a booking made without a fee gets its hold when the first fee is added.
DROP TRIGGER trg_bookings_app_fee_changed;
CREATE TRIGGER trg_bookings_app_fee_changed AFTER UPDATE OF app_fee_satang, app_fee_units ON bookings
WHEN NEW.app_fee_satang <> OLD.app_fee_satang OR NEW.app_fee_units <> OLD.app_fee_units
BEGIN
  UPDATE credit_account SET held = held + NEW.app_fee_satang / 100 - OLD.app_fee_satang / 100, updated_at = NEW.updated_at WHERE id = 1;
  UPDATE credit_holds SET amount = NEW.app_fee_satang / 100, units = NEW.app_fee_units WHERE booking_id = NEW.id;
  INSERT INTO credit_holds (booking_id, units, amount, status, created_at)
  SELECT NEW.id, NEW.app_fee_units, NEW.app_fee_satang / 100, 'HELD', NEW.updated_at
   WHERE NOT EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id);
END;
