-- Migration 0052: where each booking came from (AI Marketing, Module A — PR A1).
-- Non-destructive: one new table. First touch of the visitor's browser tab: UTM tags, the referring site's host name
-- and the landing page path. Nothing here identifies a person — no IP, no user agent, no click ID value (only which
-- kind of ad click it was), no query string — so it is kept for every booking regardless of cookie consent.
-- Written after the booking commits (best effort): a missing row only means "unknown source".

CREATE TABLE booking_attribution (
  booking_id    TEXT PRIMARY KEY REFERENCES bookings (id),
  utm_source    TEXT CHECK (utm_source IS NULL OR length(utm_source) BETWEEN 1 AND 100),
  utm_medium    TEXT CHECK (utm_medium IS NULL OR length(utm_medium) BETWEEN 1 AND 100),
  utm_campaign  TEXT CHECK (utm_campaign IS NULL OR length(utm_campaign) BETWEEN 1 AND 100),
  utm_term      TEXT CHECK (utm_term IS NULL OR length(utm_term) BETWEEN 1 AND 100),
  utm_content   TEXT CHECK (utm_content IS NULL OR length(utm_content) BETWEEN 1 AND 100),
  referrer_host TEXT CHECK (referrer_host IS NULL OR length(referrer_host) BETWEEN 1 AND 100),
  landing_path  TEXT CHECK (landing_path IS NULL OR (length(landing_path) BETWEEN 1 AND 200 AND substr(landing_path, 1, 1) = '/')),
  click_kind    TEXT NOT NULL DEFAULT 'NONE' CHECK (click_kind IN ('GCLID', 'FBCLID', 'NONE')),
  first_seen_at TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX ix_booking_attribution_created ON booking_attribution (created_at);
