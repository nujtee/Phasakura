-- Migration 0036: bookings from Booking.com / Agoda / … through Channex (phase O4). Non-destructive: one new table,
-- new columns on channex_settings.
--
-- ota_bookings: one row per Channex booking (its id), whatever happened to it here:
--   ACTIVE    — a booking here (booking_id) holds its nights
--   CANCELLED — cancelled on the OTA; the booking here was cancelled and its nights freed
--   CONFLICT  — could not be placed: the nights are taken here (double booking) or the unit is not bookable
--   UNMAPPED  — a Channex room type that no house / VIP tent is mapped to
--   RESOLVED  — a CONFLICT / UNMAPPED that staff have dealt with by hand
-- The booking itself is an ordinary row in bookings (source 'ADMIN', confirmed); this table says which OTA it came from.
CREATE TABLE ota_bookings (
  id                 TEXT PRIMARY KEY,
  channex_booking_id TEXT NOT NULL UNIQUE CHECK (length(channex_booking_id) = 36),
  booking_id         TEXT REFERENCES bookings (id),
  ota_name           TEXT NOT NULL CHECK (length(ota_name) BETWEEN 1 AND 60),
  ota_code           TEXT CHECK (ota_code IS NULL OR length(ota_code) <= 80),
  status             TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CANCELLED', 'CONFLICT', 'UNMAPPED', 'RESOLVED')),
  last_revision_id   TEXT NOT NULL CHECK (length(last_revision_id) = 36),
  arrival_date       TEXT NOT NULL CHECK (date(arrival_date) = arrival_date),
  departure_date     TEXT NOT NULL CHECK (date(departure_date) = departure_date),
  amount_minor       INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency           TEXT NOT NULL CHECK (length(currency) = 3),
  payment_collect    TEXT CHECK (payment_collect IS NULL OR payment_collect IN ('ota', 'property')),
  guest_name         TEXT CHECK (guest_name IS NULL OR length(guest_name) <= 200),
  problem            TEXT CHECK (problem IS NULL OR length(problem) <= 300),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  resolved_by        TEXT REFERENCES users (id)
) STRICT;
CREATE INDEX ix_ota_bookings_booking ON ota_bookings (booking_id);
CREATE INDEX ix_ota_bookings_status ON ota_bookings (status, updated_at);

ALTER TABLE channex_settings ADD COLUMN last_feed_at TEXT;
ALTER TABLE channex_settings ADD COLUMN last_feed_status TEXT CHECK (last_feed_status IS NULL OR last_feed_status IN ('OK', 'ERROR'));
ALTER TABLE channex_settings ADD COLUMN last_feed_error TEXT CHECK (last_feed_error IS NULL OR length(last_feed_error) <= 300);
