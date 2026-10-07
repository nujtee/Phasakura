-- Migration 0006: receiving accounts, payment snapshots, payments, slip verification, notifications

CREATE TABLE receiving_accounts (
  id               TEXT PRIMARY KEY,
  bank_name        TEXT NOT NULL,
  account_name     TEXT NOT NULL,
  account_number   TEXT CHECK (account_number IS NULL OR account_number NOT GLOB '*[^0-9-]*'),
  promptpay_number TEXT CHECK (promptpay_number IS NULL OR promptpay_number NOT GLOB '*[^0-9]*'),
  qr_asset_id      TEXT REFERENCES media_assets (id),
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'DELETED')),
  is_primary       INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT REFERENCES users (id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (account_number IS NOT NULL OR promptpay_number IS NOT NULL),
  CHECK (is_primary = 0 OR status = 'ACTIVE')
) STRICT;

-- At most one primary receiving account.
CREATE UNIQUE INDEX ux_receiving_accounts_single_primary ON receiving_accounts (is_primary) WHERE is_primary = 1;

-- Account details copied onto the booking at creation (spec §25). Immutable.
CREATE TABLE payment_account_snapshots (
  booking_id                TEXT PRIMARY KEY REFERENCES bookings (id),
  receiving_account_id      TEXT NOT NULL REFERENCES receiving_accounts (id),
  bank_name_snapshot        TEXT NOT NULL,
  account_name_snapshot     TEXT NOT NULL,
  account_number_snapshot   TEXT,
  promptpay_number_snapshot TEXT,
  payment_qr_snapshot       TEXT,       -- R2 object key of the QR at booking time
  captured_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER trg_payment_account_snapshots_no_update BEFORE UPDATE ON payment_account_snapshots
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_payment_account_snapshots_no_delete BEFORE DELETE ON payment_account_snapshots
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

-- A payment attempt (usually one slip upload). Booking.payment_status is the summary.
CREATE TABLE payments (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL REFERENCES bookings (id),
  amount_satang    INTEGER NOT NULL CHECK (amount_satang > 0),
  method           TEXT NOT NULL CHECK (method IN ('BANK_TRANSFER', 'PROMPTPAY', 'CASH', 'OTHER')),
  status           TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
                   CHECK (status IN ('UNPAID', 'PENDING_VERIFICATION', 'VERIFIED', 'PAID', 'REJECTED', 'REFUNDED')),
  slip_asset_id    TEXT REFERENCES media_assets (id),   -- PRIVATE bucket only (enforced by media_assets)
  slip_sha256      TEXT CHECK (slip_sha256 IS NULL OR length(slip_sha256) = 64),
  paid_at          TEXT,              -- transfer time as stated on the slip / verified
  submitted_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  verified_at      TEXT,
  verified_by      TEXT REFERENCES users (id),
  rejected_reason  TEXT,
  refunded_at      TEXT,
  refunded_by      TEXT REFERENCES users (id),
  refund_amount_satang INTEGER CHECK (refund_amount_satang IS NULL OR refund_amount_satang > 0),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (status <> 'REJECTED' OR rejected_reason IS NOT NULL),
  CHECK (status <> 'REFUNDED' OR (refunded_at IS NOT NULL AND refund_amount_satang IS NOT NULL)),
  CHECK (refund_amount_satang IS NULL OR refund_amount_satang <= amount_satang)
) STRICT;

CREATE INDEX ix_payments_booking ON payments (booking_id);
CREATE INDEX ix_payments_status ON payments (status, submitted_at);

-- A slip must be a PAYMENT_SLIP asset (which media_assets forces into the PRIVATE bucket).
CREATE TRIGGER trg_payments_slip_private_insert BEFORE INSERT ON payments
WHEN NEW.slip_asset_id IS NOT NULL
 AND (SELECT purpose FROM media_assets WHERE id = NEW.slip_asset_id) IS NOT 'PAYMENT_SLIP'
BEGIN
  SELECT RAISE(ABORT, 'SLIP_MUST_BE_PRIVATE');
END;

CREATE TRIGGER trg_payments_slip_private_update BEFORE UPDATE OF slip_asset_id ON payments
WHEN NEW.slip_asset_id IS NOT NULL
 AND (SELECT purpose FROM media_assets WHERE id = NEW.slip_asset_id) IS NOT 'PAYMENT_SLIP'
BEGIN
  SELECT RAISE(ABORT, 'SLIP_MUST_BE_PRIVATE');
END;

-- Duplicate slip protection: the same slip image cannot back two live payments.
CREATE UNIQUE INDEX ux_payments_slip_sha256_live ON payments (slip_sha256)
  WHERE slip_sha256 IS NOT NULL AND status IN ('PENDING_VERIFICATION', 'VERIFIED', 'PAID');

-- Each verification attempt (manual or automatic via a real slip verification service).
CREATE TABLE slip_verifications (
  id                         TEXT PRIMARY KEY,
  payment_id                 TEXT NOT NULL REFERENCES payments (id),
  method                     TEXT NOT NULL CHECK (method IN ('MANUAL', 'AUTO')),
  provider                   TEXT,                      -- AUTO: service name
  result                     TEXT NOT NULL CHECK (result IN ('PASSED', 'FAILED', 'ERROR')),
  failure_code               TEXT,                      -- AMOUNT_MISMATCH, DUPLICATE_TRANSACTION, …
  amount_satang              INTEGER CHECK (amount_satang IS NULL OR amount_satang >= 0),
  transferred_at             TEXT,
  sender_bank                TEXT,
  receiver_bank              TEXT,
  receiver_account_masked    TEXT,                      -- masked only, never full number of sender
  transaction_ref            TEXT,
  provider_response_redacted TEXT CHECK (provider_response_redacted IS NULL OR json_valid(provider_response_redacted)),
  verified_by                TEXT REFERENCES users (id),
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (method <> 'MANUAL' OR verified_by IS NOT NULL),
  CHECK (method <> 'AUTO' OR provider IS NOT NULL),
  CHECK (result <> 'FAILED' OR failure_code IS NOT NULL)
) STRICT;

CREATE INDEX ix_slip_verifications_payment ON slip_verifications (payment_id, created_at);

-- Duplicate transaction protection: a bank transaction reference can pass only once.
CREATE UNIQUE INDEX ux_slip_verifications_transaction_ref ON slip_verifications (transaction_ref)
  WHERE result = 'PASSED' AND transaction_ref IS NOT NULL;

CREATE TRIGGER trg_slip_verifications_no_update BEFORE UPDATE ON slip_verifications
BEGIN
  SELECT RAISE(ABORT, 'SLIP_VERIFICATION_IMMUTABLE');
END;

CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_DELETE_FORBIDDEN');
END;

-- ---------------------------------------------------------------------------
-- Notification log (LINE, spec §47): idempotency + retry bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE notification_logs (
  id                TEXT PRIMARY KEY,
  channel           TEXT NOT NULL CHECK (channel IN ('LINE')),
  notification_type TEXT NOT NULL,      -- CHECKIN_TOMORROW, NEW_BOOKING, PAYMENT_SUBMITTED, FOOD_ORDER, …
  idempotency_key   TEXT NOT NULL UNIQUE,
  booking_id        TEXT REFERENCES bookings (id),
  language_code     TEXT REFERENCES languages (code),
  recipient         TEXT NOT NULL,      -- LINE target id (group/user) — not customer PII
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at   TEXT,
  last_error        TEXT,
  payload_json      TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  scheduled_for     TEXT NOT NULL,
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (attempts <= max_attempts),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
) STRICT;

CREATE INDEX ix_notification_logs_due ON notification_logs (status, next_attempt_at, scheduled_for);
CREATE INDEX ix_notification_logs_booking ON notification_logs (booking_id);
