-- Migration 0015: admin dashboard support (Phase 9)
-- Non-destructive: new triggers and indexes only. No table rebuild, no data change.

-- ---------------------------------------------------------------------------
-- Booking status may only move along the documented lifecycle (spec §13, §26):
--   PENDING   → CONFIRMED | EXPIRED | CANCELLED
--   CONFIRMED → CHECKED_IN | CANCELLED | NO_SHOW
--   CHECKED_IN → CHECKED_OUT
-- CANCELLED / EXPIRED / CHECKED_OUT / NO_SHOW are final.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_bookings_status_transition BEFORE UPDATE OF booking_status ON bookings
WHEN NEW.booking_status <> OLD.booking_status
 AND NOT (
      (OLD.booking_status = 'PENDING'    AND NEW.booking_status IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
   OR (OLD.booking_status = 'CONFIRMED'  AND NEW.booking_status IN ('CHECKED_IN', 'CANCELLED', 'NO_SHOW'))
   OR (OLD.booking_status = 'CHECKED_IN' AND NEW.booking_status = 'CHECKED_OUT'))
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_STATUS_TRANSITION');
END;

-- ---------------------------------------------------------------------------
-- Kitchen order status (spec §24) moves forward only:
--   PENDING → CONFIRMED → PREPARING → READY → SERVED   (steps may be skipped)
-- CANCELLED is reachable from any state (booking cancelled / expired) and is final.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_food_orders_status_transition BEFORE UPDATE OF status ON food_orders
WHEN NEW.status <> OLD.status
 AND (OLD.status = 'CANCELLED'
      OR (NEW.status <> 'CANCELLED'
          AND (CASE NEW.status WHEN 'PENDING' THEN 0 WHEN 'CONFIRMED' THEN 1 WHEN 'PREPARING' THEN 2
                               WHEN 'READY' THEN 3 WHEN 'SERVED' THEN 4 END)
           <= (CASE OLD.status WHEN 'PENDING' THEN 0 WHEN 'CONFIRMED' THEN 1 WHEN 'PREPARING' THEN 2
                               WHEN 'READY' THEN 3 WHEN 'SERVED' THEN 4 END)))
BEGIN
  SELECT RAISE(ABORT, 'FOOD_ORDER_STATUS_TRANSITION');
END;

-- ---------------------------------------------------------------------------
-- Theme versions: a PUBLISHED or ARCHIVED version is history — its tokens never change.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_theme_versions_tokens_frozen BEFORE UPDATE OF tokens_json, preset ON theme_versions
WHEN OLD.status <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'THEME_VERSION_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- Indexes for dashboard, calendar and admin lists
-- ---------------------------------------------------------------------------
CREATE INDEX ix_payments_submitted ON payments (submitted_at);
CREATE INDEX ix_bookings_confirmed ON bookings (confirmed_at) WHERE confirmed_at IS NOT NULL;
CREATE INDEX ix_food_orders_status ON food_orders (status, service_date);
CREATE INDEX ix_gallery_images_sort ON gallery_images (sort_order);
CREATE INDEX ix_history_sections_sort ON history_sections (sort_order);
