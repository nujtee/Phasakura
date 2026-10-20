-- Migration 0034: Channex connection (phase O2) — which Channex property this site is, and which Channex room type /
-- rate plan each house / VIP tent is. Non-destructive: two new tables. The API key is a Cloudflare Secret
-- (CHANNEX_API_KEY), never in the database; CHANNEX_ENV picks staging (default) or production.

CREATE TABLE channex_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  property_id       TEXT CHECK (property_id IS NULL OR length(property_id) = 36),
  property_title    TEXT CHECK (property_title IS NULL OR length(property_title) <= 255),
  currency          TEXT CHECK (currency IS NULL OR length(currency) = 3),
  environment       TEXT CHECK (environment IS NULL OR environment IN ('staging', 'production')),
  last_check_at     TEXT,
  last_check_status TEXT CHECK (last_check_status IS NULL OR last_check_status IN ('OK', 'ERROR')),
  last_check_error  TEXT CHECK (last_check_error IS NULL OR length(last_check_error) <= 300),
  updated_by        TEXT REFERENCES users (id),
  updated_at        TEXT
) STRICT;
INSERT INTO channex_settings (id) VALUES (1);

-- One Channex room type (a single unit: count_of_rooms 1) and one rate plan per house / VIP tent.
CREATE TABLE channex_unit_map (
  unit_id         TEXT PRIMARY KEY REFERENCES accommodation_units (id),
  room_type_id    TEXT NOT NULL UNIQUE CHECK (length(room_type_id) = 36),
  room_type_title TEXT CHECK (room_type_title IS NULL OR length(room_type_title) <= 255),
  rate_plan_id    TEXT UNIQUE CHECK (rate_plan_id IS NULL OR length(rate_plan_id) = 36),
  rate_plan_title TEXT CHECK (rate_plan_title IS NULL OR length(rate_plan_title) <= 255),
  updated_by      TEXT REFERENCES users (id),
  updated_at      TEXT NOT NULL
) STRICT;
