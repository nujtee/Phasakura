-- Migration 0037: staff confirm the payment of a booking whose payment time ran out (EXPIRED → CONFIRMED).
-- Non-destructive: two triggers replaced / added, no table change.
--
-- The guest paid (a transfer seen in the bank app, a slip sent by LINE…) but the hold ended first. Staff record the
-- payment; the booking takes its nights, tents, tarp area and meals back in the same batch, or the whole batch fails
-- (night taken meanwhile, camping full, kitchen full, credits short). Its app fee is taken then, once.

DROP TRIGGER trg_bookings_status_transition;
CREATE TRIGGER trg_bookings_status_transition BEFORE UPDATE OF booking_status ON bookings
WHEN NEW.booking_status <> OLD.booking_status
 AND NOT (
      (OLD.booking_status = 'PENDING'    AND NEW.booking_status IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
   OR (OLD.booking_status = 'EXPIRED'    AND NEW.booking_status = 'CONFIRMED')
   OR (OLD.booking_status = 'CONFIRMED'  AND NEW.booking_status IN ('CHECKED_IN', 'CANCELLED', 'NO_SHOW'))
   OR (OLD.booking_status = 'CHECKED_IN' AND NEW.booking_status = 'CHECKED_OUT'))
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_STATUS_TRANSITION');
END;

-- The released credits are taken again, or the whole batch fails.
CREATE TRIGGER trg_bookings_credit_reinstate_check BEFORE UPDATE OF booking_status ON bookings
WHEN OLD.booking_status = 'EXPIRED' AND NEW.booking_status = 'CONFIRMED'
 AND EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id AND status = 'RELEASED')
BEGIN
  SELECT RAISE(ABORT, 'CREDIT_INSUFFICIENT')
   WHERE COALESCE((SELECT balance - held FROM credit_account WHERE id = 1), 0) < (SELECT amount FROM credit_holds WHERE booking_id = NEW.id);
END;
CREATE TRIGGER trg_bookings_credit_reinstate AFTER UPDATE OF booking_status ON bookings
WHEN OLD.booking_status = 'EXPIRED' AND NEW.booking_status = 'CONFIRMED'
 AND EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id AND status = 'RELEASED')
BEGIN
  UPDATE credit_account
     SET balance = balance - (SELECT amount FROM credit_holds WHERE booking_id = NEW.id), updated_at = NEW.updated_at
   WHERE id = 1;
  INSERT INTO credit_ledger (id, entry_type, amount, balance_after, booking_id, units, created_at)
  SELECT lower(hex(randomblob(16))), 'FEE_CAPTURE', -h.amount, (SELECT balance FROM credit_account WHERE id = 1), NEW.id, h.units, NEW.updated_at
    FROM credit_holds h WHERE h.booking_id = NEW.id;
  UPDATE credit_holds SET status = 'CAPTURED', settled_at = NEW.updated_at WHERE booking_id = NEW.id;
END;

-- Meals of the booking come back too: a cancelled order may reopen (PENDING) only for a booking that is confirmed —
-- which the batch above makes it first. Any other way out of CANCELLED is still refused.
DROP TRIGGER trg_food_orders_status_transition;
CREATE TRIGGER trg_food_orders_status_transition BEFORE UPDATE OF status ON food_orders
WHEN NEW.status <> OLD.status
 AND ((OLD.status = 'CANCELLED'
       AND NOT (NEW.status = 'PENDING' AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = NEW.booking_id AND b.booking_status = 'CONFIRMED')))
      OR (OLD.status <> 'CANCELLED' AND NEW.status <> 'CANCELLED'
          AND (CASE NEW.status WHEN 'PENDING' THEN 0 WHEN 'CONFIRMED' THEN 1 WHEN 'PREPARING' THEN 2
                               WHEN 'READY' THEN 3 WHEN 'SERVED' THEN 4 END)
           <= (CASE OLD.status WHEN 'PENDING' THEN 0 WHEN 'CONFIRMED' THEN 1 WHEN 'PREPARING' THEN 2
                               WHEN 'READY' THEN 3 WHEN 'SERVED' THEN 4 END)))
BEGIN
  SELECT RAISE(ABORT, 'FOOD_ORDER_STATUS_TRANSITION');
END;
