-- Migration 0023: payment channels, slip approval mode, PayPal Checkout, e-mail notifications
-- Non-destructive: new tables (two seeded singletons), two new nullable / defaulted columns, triggers and
-- indexes. No existing row changes meaning; no table is rebuilt.
--
-- Secrets are NEVER stored here — they are Cloudflare Secrets:
--   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (PayPal REST app), RESEND_API_KEY (e-mail),
--   SLIP_VERIFICATION_API_KEY (EasySlip).

-- ---------------------------------------------------------------------------
-- Payment settings (Admin → Finance → Payment settings), singleton.
--   approval_mode AUTO   : a slip that the verification service proves correct confirms the booking;
--                          anything else waits for staff (who are notified).
--   approval_mode MANUAL : staff approve every slip; the verification result is shown to help them.
--   *_enabled            : which channels the guest may choose (each also needs the matching detail on
--                          the receiving account: PromptPay number, account number, QR image).
-- ---------------------------------------------------------------------------
CREATE TABLE payment_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  approval_mode         TEXT NOT NULL DEFAULT 'AUTO' CHECK (approval_mode IN ('AUTO', 'MANUAL')),
  promptpay_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (promptpay_enabled IN (0, 1)),
  bank_transfer_enabled INTEGER NOT NULL DEFAULT 1 CHECK (bank_transfer_enabled IN (0, 1)),
  qr_enabled            INTEGER NOT NULL DEFAULT 1 CHECK (qr_enabled IN (0, 1)),
  paypal_enabled        INTEGER NOT NULL DEFAULT 0 CHECK (paypal_enabled IN (0, 1)),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by            TEXT REFERENCES users (id),
  CHECK (promptpay_enabled + bank_transfer_enabled + qr_enabled + paypal_enabled >= 1)
) STRICT;

INSERT INTO payment_settings (id) VALUES (1);

-- ---------------------------------------------------------------------------
-- The channel the guest chose for a payment (NULL = recorded by staff / before this migration).
-- `method` keeps its meaning (BANK_TRANSFER, PROMPTPAY, CASH, OTHER); PayPal is method OTHER + channel PAYPAL.
-- ---------------------------------------------------------------------------
ALTER TABLE payments ADD COLUMN channel TEXT
  CHECK (channel IS NULL OR channel IN ('PROMPTPAY', 'BANK_TRANSFER', 'QR_CODE', 'PAYPAL'));

CREATE TRIGGER trg_payments_channel_frozen BEFORE UPDATE OF channel ON payments
WHEN NEW.channel IS NOT OLD.channel
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- PayPal Checkout orders (Orders v2, intent CAPTURE). Money moves only when we capture, and we capture
-- only after claiming the booking (still PENDING, hold not over), so an expired booking is never charged.
--   CREATED    order made, guest sent to PayPal
--   CAPTURING  booking claimed, capture call in flight (the cron settles it if the Worker stopped)
--   CAPTURED   money taken, payment row written, booking confirmed
--   PENDING    PayPal holds the capture for review — staff confirm by hand
--   FAILED     declined / not approved / amount mismatch — booking released back to the guest
--   CANCELLED  guest cancelled at PayPal, or a newer order replaced this one
-- ---------------------------------------------------------------------------
CREATE TABLE paypal_orders (
  id              TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64 AND id NOT GLOB '*[^A-Za-z0-9-]*'),
  booking_id      TEXT NOT NULL REFERENCES bookings (id),
  amount_satang   INTEGER NOT NULL CHECK (amount_satang > 0),
  currency        TEXT NOT NULL DEFAULT 'THB' CHECK (currency = 'THB'),
  environment     TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
  status          TEXT NOT NULL DEFAULT 'CREATED'
                  CHECK (status IN ('CREATED', 'CAPTURING', 'CAPTURED', 'PENDING', 'FAILED', 'CANCELLED')),
  hold_expires_at TEXT,             -- the booking's hold when it was claimed (given back if the capture fails)
  prior_payment_status TEXT CHECK (prior_payment_status IS NULL OR prior_payment_status IN ('UNPAID', 'REJECTED')),
  capture_id      TEXT UNIQUE CHECK (capture_id IS NULL OR (length(capture_id) BETWEEN 8 AND 64 AND capture_id NOT GLOB '*[^A-Za-z0-9-]*')),
  payment_id      TEXT REFERENCES payments (id),
  failure_code    TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 60),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (status <> 'CAPTURED' OR (capture_id IS NOT NULL AND payment_id IS NOT NULL))
) STRICT;

CREATE INDEX ix_paypal_orders_booking ON paypal_orders (booking_id, created_at);
CREATE INDEX ix_paypal_orders_status ON paypal_orders (status, updated_at);

CREATE TRIGGER trg_paypal_orders_money_frozen BEFORE UPDATE ON paypal_orders
WHEN NEW.amount_satang IS NOT OLD.amount_satang OR NEW.booking_id IS NOT OLD.booking_id
  OR NEW.currency IS NOT OLD.currency OR NEW.environment IS NOT OLD.environment
BEGIN
  SELECT RAISE(ABORT, 'PAYPAL_ORDER_IMMUTABLE');
END;

CREATE TRIGGER trg_paypal_orders_captured_final BEFORE UPDATE OF status ON paypal_orders
WHEN OLD.status = 'CAPTURED' AND NEW.status <> 'CAPTURED'
BEGIN
  SELECT RAISE(ABORT, 'PAYPAL_ORDER_CAPTURED');
END;

-- ---------------------------------------------------------------------------
-- LINE: staff chats may now be told about every new booking (existing chats: on).
-- ---------------------------------------------------------------------------
ALTER TABLE line_recipients ADD COLUMN notify_booking INTEGER NOT NULL DEFAULT 1 CHECK (notify_booking IN (0, 1));

-- ---------------------------------------------------------------------------
-- E-mail (sent through Resend). Settings singleton: off until the owner sets a verified sender.
-- ---------------------------------------------------------------------------
CREATE TABLE email_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  guest_enabled INTEGER NOT NULL DEFAULT 1 CHECK (guest_enabled IN (0, 1)),
  from_name     TEXT CHECK (from_name IS NULL OR length(trim(from_name)) BETWEEN 1 AND 80),
  from_email    TEXT CHECK (from_email IS NULL OR (length(from_email) BETWEEN 6 AND 254 AND instr(from_email, '@') > 1)),
  reply_to      TEXT CHECK (reply_to IS NULL OR (length(reply_to) BETWEEN 6 AND 254 AND instr(reply_to, '@') > 1)),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by    TEXT REFERENCES users (id),
  CHECK (enabled = 0 OR from_email IS NOT NULL)
) STRICT;

INSERT INTO email_settings (id) VALUES (1);

-- Staff addresses that receive notifications.
CREATE TABLE email_recipients (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL CHECK (length(email) BETWEEN 6 AND 254 AND instr(email, '@') > 1 AND email = lower(email)),
  name           TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  language_code  TEXT NOT NULL REFERENCES languages (code),
  notify_booking INTEGER NOT NULL DEFAULT 1 CHECK (notify_booking IN (0, 1)),
  notify_payment INTEGER NOT NULL DEFAULT 1 CHECK (notify_payment IN (0, 1)),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users (id),
  updated_at     TEXT NOT NULL,
  updated_by     TEXT REFERENCES users (id),
  CHECK (deleted_at IS NULL OR active = 0)
) STRICT;

CREATE UNIQUE INDEX ux_email_recipients_email_live ON email_recipients (email) WHERE deleted_at IS NULL;

-- Outbox (same guarantees as notification_logs): rows are written in the batch that causes them.
-- `recipient` is a reference, never an address: 'staff:<email_recipients.id>' or 'guest:<bookings.id>'.
CREATE TABLE email_logs (
  id                  TEXT PRIMARY KEY,
  notification_type   TEXT NOT NULL CHECK (length(notification_type) BETWEEN 3 AND 40),
  idempotency_key     TEXT NOT NULL UNIQUE,
  booking_id          TEXT REFERENCES bookings (id),
  language_code       TEXT REFERENCES languages (code),
  recipient           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at     TEXT,
  last_error          TEXT,
  payload_json        TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 100),
  scheduled_for       TEXT NOT NULL,
  sent_at             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (attempts <= max_attempts),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
) STRICT;

CREATE INDEX ix_email_logs_due ON email_logs (status, next_attempt_at, scheduled_for);
CREATE INDEX ix_email_logs_booking ON email_logs (booking_id);
CREATE INDEX ix_email_logs_created ON email_logs (created_at);

CREATE TRIGGER trg_email_logs_sent_final BEFORE UPDATE OF status ON email_logs
WHEN OLD.status = 'SENT' AND NEW.status <> 'SENT'
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_SENT_FINAL');
END;
