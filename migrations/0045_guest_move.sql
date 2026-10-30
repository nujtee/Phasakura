-- Migration 0045: guests move their own stay (เลื่อนวันเข้าพัก) from the booking page, for a fee.
-- Non-destructive: settings (one row, off), a request table, one nullable column on payments. No row changes.
--
-- Flow: the guest (Booking ID + phone) picks new dates (and another free house / VIP tent when theirs is taken) →
-- a request AWAITING_PAYMENT holds the new nights (booking_unit_nights blocks 'MOVE_HOLD:<request id>') → the guest
-- transfers fee + any higher price of the new nights and sends the slip (payments.move_request_id) → REVIEWING →
-- the slip is verified (automatically or by staff): the stay moves in the same batch (APPROVED), or it is turned
-- down (REJECTED) / never paid in time (EXPIRED) / given up (CANCELLED): the held nights are released.

CREATE TABLE move_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  is_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  fee_satang       INTEGER NOT NULL DEFAULT 0 CHECK (fee_satang >= 0 AND fee_satang <= 10000000),
  -- Moves allowed until this many days before the check-in (the old one and the new one).
  min_days_before  INTEGER NOT NULL DEFAULT 3 CHECK (min_days_before BETWEEN 0 AND 365),
  -- Moves (approved) per booking.
  max_moves        INTEGER NOT NULL DEFAULT 1 CHECK (max_moves BETWEEN 1 AND 10),
  -- The new nights are held this long for the transfer.
  pay_minutes      INTEGER NOT NULL DEFAULT 60 CHECK (pay_minutes BETWEEN 15 AND 1440),
  updated_by       TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO move_settings (id) VALUES (1);

CREATE TABLE booking_move_requests (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT NOT NULL REFERENCES bookings (id),
  status          TEXT NOT NULL CHECK (status IN ('AWAITING_PAYMENT', 'REVIEWING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED')),
  from_check_in   TEXT NOT NULL CHECK (date(from_check_in) = from_check_in),
  from_check_out  TEXT NOT NULL CHECK (date(from_check_out) = from_check_out),
  to_check_in     TEXT NOT NULL CHECK (date(to_check_in) = to_check_in),
  to_check_out    TEXT NOT NULL CHECK (date(to_check_out) = to_check_out),
  -- [{ itemId, fromUnitId, fromName, toUnitId, toName }] — every house / VIP tent of the booking.
  rooms_json      TEXT NOT NULL CHECK (json_valid(rooms_json)),
  fee_satang      INTEGER NOT NULL CHECK (fee_satang >= 0),
  -- Higher price of the new nights (never negative: a cheaper stay is not refunded).
  diff_satang     INTEGER NOT NULL CHECK (diff_satang >= 0),
  amount_satang   INTEGER NOT NULL CHECK (amount_satang = fee_satang + diff_satang),
  expires_at      TEXT NOT NULL,
  reason          TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  decided_at      TEXT,
  decided_by      TEXT REFERENCES users (id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX ix_move_requests_booking ON booking_move_requests (booking_id, created_at);
-- One open request per booking.
CREATE UNIQUE INDEX ux_move_requests_open ON booking_move_requests (booking_id) WHERE status IN ('AWAITING_PAYMENT', 'REVIEWING');

-- The money of a request never changes once asked.
CREATE TRIGGER trg_move_requests_frozen BEFORE UPDATE OF booking_id, from_check_in, to_check_in, rooms_json, fee_satang, diff_satang, amount_satang
ON booking_move_requests
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

-- Requests end once: an ended request never opens again.
CREATE TRIGGER trg_move_requests_status BEFORE UPDATE OF status ON booking_move_requests
WHEN NEW.status <> OLD.status AND NOT (
     (OLD.status = 'AWAITING_PAYMENT' AND NEW.status IN ('REVIEWING', 'EXPIRED', 'CANCELLED', 'APPROVED', 'FAILED')) -- APPROVED: nothing to pay
  OR (OLD.status = 'REVIEWING' AND NEW.status IN ('APPROVED', 'REJECTED', 'FAILED', 'CANCELLED')))
BEGIN
  SELECT RAISE(ABORT, 'MOVE_REQUEST_STATUS');
END;

-- The slip of a move: what the guest paid for it (amount = the request's amount).
ALTER TABLE payments ADD COLUMN move_request_id TEXT REFERENCES booking_move_requests (id);

CREATE TRIGGER trg_payments_move_amount BEFORE INSERT ON payments
WHEN NEW.move_request_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM booking_move_requests r WHERE r.id = NEW.move_request_id AND r.booking_id = NEW.booking_id
                  AND r.amount_satang = NEW.amount_satang AND r.status = 'REVIEWING')
BEGIN
  SELECT RAISE(ABORT, 'MOVE_PAYMENT_INVALID');
END;
