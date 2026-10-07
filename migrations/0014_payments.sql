-- Migration 0014: payment recording details (non-destructive: ADD COLUMN, triggers, index)

-- Bank / receipt reference the staff entered when recording a payment.
ALTER TABLE payments ADD COLUMN reference TEXT CHECK (reference IS NULL OR length(reference) <= 100);
ALTER TABLE payments ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) <= 500);
ALTER TABLE payments ADD COLUMN refund_reason TEXT CHECK (refund_reason IS NULL OR length(refund_reason) <= 500);

-- Money fields of a payment never change after it is recorded; only its status moves forward.
CREATE TRIGGER trg_payments_amount_frozen BEFORE UPDATE ON payments
WHEN NEW.amount_satang IS NOT OLD.amount_satang
  OR NEW.booking_id IS NOT OLD.booking_id
  OR NEW.method IS NOT OLD.method
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_IMMUTABLE');
END;

-- A refunded payment is final.
CREATE TRIGGER trg_payments_refund_final BEFORE UPDATE OF status ON payments
WHEN OLD.status = 'REFUNDED' AND NEW.status <> 'REFUNDED'
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_ALREADY_REFUNDED');
END;

-- Payments can only be recorded against bookings that still exist as live business records.
CREATE TRIGGER trg_payments_booking_live BEFORE INSERT ON payments
WHEN (SELECT booking_status FROM bookings WHERE id = NEW.booking_id) IN ('CANCELLED', 'EXPIRED')
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_NOT_PAYABLE');
END;

CREATE INDEX ix_receiving_accounts_status ON receiving_accounts (status, sort_order);
