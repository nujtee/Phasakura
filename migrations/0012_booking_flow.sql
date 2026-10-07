-- Migration 0012: booking flow support (non-destructive: ADD COLUMN, new indexes, data backfill)

-- A meal's service date relative to a stay night:
--   0 = same evening as the night (dinner, BBQ)
--   1 = the morning after the night (breakfast)
ALTER TABLE food_categories
  ADD COLUMN service_day_offset INTEGER NOT NULL DEFAULT 0 CHECK (service_day_offset IN (0, 1));

UPDATE food_categories SET service_day_offset = 1 WHERE code = 'BREAKFAST';

-- Client-generated key: a repeated "Confirm" (double click, retry) returns the same booking.
ALTER TABLE bookings ADD COLUMN idempotency_key TEXT
  CHECK (idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 16 AND 64 AND idempotency_key NOT GLOB '*[^A-Za-z0-9-]*'));

CREATE UNIQUE INDEX ux_bookings_idempotency_key ON bookings (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- PDPA: when the guest accepted the privacy notice.
ALTER TABLE bookings ADD COLUMN privacy_accepted_at TEXT;

CREATE INDEX ix_booking_food_items_order ON booking_food_items (food_order_id);

-- Exactly how many portions this kitchen order reserved in food_daily_capacity.
-- Releasing (cancel / expiry) subtracts this amount once and sets it to 0,
-- so a release can never run twice or subtract capacity that was never taken.
ALTER TABLE food_orders ADD COLUMN capacity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (capacity_reserved >= 0);

-- Booking configuration (single row). Admin-editable in Phase 9.
CREATE TABLE booking_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  hold_minutes      INTEGER NOT NULL DEFAULT 60 CHECK (hold_minutes BETWEEN 5 AND 10080),  -- unpaid PENDING hold
  max_nights        INTEGER NOT NULL DEFAULT 30 CHECK (max_nights BETWEEN 1 AND 365),
  max_advance_days  INTEGER NOT NULL DEFAULT 365 CHECK (max_advance_days BETWEEN 1 AND 730),
  max_tents_per_booking INTEGER NOT NULL DEFAULT 10 CHECK (max_tents_per_booking BETWEEN 1 AND 100),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by        TEXT REFERENCES users (id)
) STRICT;

INSERT INTO booking_settings (id) VALUES (1);
