-- Migration 0019: cookie consent / privacy settings, marketing attribution, Meta Conversions API outbox (Phase 14)
-- Non-destructive: new tables, one seeded settings row, indexes and triggers, and one new nullable column
-- (marketing_settings.ga4_property_id). No existing data is changed or removed.

-- ---------------------------------------------------------------------------
-- Privacy & cookie consent (spec §46). Raising consent_version asks every visitor again.
-- ---------------------------------------------------------------------------
CREATE TABLE privacy_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  banner_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (banner_enabled IN (0, 1)),
  consent_version INTEGER NOT NULL DEFAULT 1 CHECK (consent_version BETWEEN 1 AND 9999),
  consent_days    INTEGER NOT NULL DEFAULT 180 CHECK (consent_days BETWEEN 30 AND 395),
  updated_at      TEXT NOT NULL,
  updated_by      TEXT REFERENCES users (id)
) STRICT;

INSERT INTO privacy_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Banner wording and the privacy policy page, per language (plain text; paragraphs separated by blank lines).
CREATE TABLE privacy_setting_translations (
  language_code TEXT PRIMARY KEY REFERENCES languages (code),
  banner_text   TEXT CHECK (banner_text IS NULL OR length(banner_text) <= 600),
  policy_title  TEXT CHECK (policy_title IS NULL OR length(policy_title) <= 120),
  policy_body   TEXT CHECK (policy_body IS NULL OR length(policy_body) <= 30000),
  updated_at    TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- Marketing attribution of a booking (spec §45). Browser identifiers are kept only when the
-- visitor gave Marketing consent, and are erased after 8 days (Meta accepts events up to 7 days).
-- ---------------------------------------------------------------------------
CREATE TABLE booking_marketing (
  booking_id        TEXT PRIMARY KEY REFERENCES bookings (id),
  consent_version   INTEGER NOT NULL CHECK (consent_version >= 0),
  analytics_consent INTEGER NOT NULL CHECK (analytics_consent IN (0, 1)),
  marketing_consent INTEGER NOT NULL CHECK (marketing_consent IN (0, 1)),
  fbp               TEXT CHECK (fbp IS NULL OR length(fbp) <= 100),
  fbc               TEXT CHECK (fbc IS NULL OR length(fbc) <= 300),
  user_agent        TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  ip_address        TEXT CHECK (ip_address IS NULL OR length(ip_address) <= 64),
  source_url        TEXT CHECK (source_url IS NULL OR length(source_url) <= 500),
  created_at        TEXT NOT NULL,
  purged_at         TEXT,
  CHECK (marketing_consent = 1 OR (fbp IS NULL AND fbc IS NULL AND user_agent IS NULL AND ip_address IS NULL))
) STRICT;

CREATE INDEX ix_booking_marketing_purge ON booking_marketing (created_at) WHERE purged_at IS NULL;

-- ---------------------------------------------------------------------------
-- Meta Conversions API outbox (spec §45): rows are written in the same batch as the booking /
-- confirmation, so an event exists if and only if the change committed. No personal data here:
-- the request is built at send time. event_id is shared with the browser Pixel (deduplication).
-- ---------------------------------------------------------------------------
CREATE TABLE marketing_events (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL DEFAULT 'META_CAPI' CHECK (channel IN ('META_CAPI')),
  event_name      TEXT NOT NULL CHECK (event_name IN ('Lead', 'Purchase', 'PageView')),
  event_id        TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 100),
  booking_id      TEXT REFERENCES bookings (id),
  event_time      TEXT NOT NULL,
  is_test         INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at TEXT NOT NULL,
  lease_until     TEXT,
  last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
  skip_reason     TEXT CHECK (skip_reason IS NULL OR length(skip_reason) <= 40),
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  CHECK (status <> 'SENT' OR sent_at IS NOT NULL),
  CHECK (event_name = 'PageView' OR booking_id IS NOT NULL)
) STRICT;

CREATE INDEX ix_marketing_events_due ON marketing_events (status, next_attempt_at);
CREATE INDEX ix_marketing_events_created ON marketing_events (created_at);
CREATE INDEX ix_marketing_events_booking ON marketing_events (booking_id) WHERE booking_id IS NOT NULL;

-- A delivered event is final.
CREATE TRIGGER trg_marketing_events_sent_final BEFORE UPDATE OF status ON marketing_events
WHEN OLD.status = 'SENT' AND NEW.status <> 'SENT'
BEGIN
  SELECT RAISE(ABORT, 'MARKETING_EVENT_SENT_FINAL');
END;

-- ---------------------------------------------------------------------------
-- GA4 Data API for the dashboard (spec §48: visitors, page views, funnel). The property id is
-- configuration; the service-account key is a Cloudflare Secret (GA4_SERVICE_ACCOUNT_KEY), never D1.
-- Reports are cached here (numbers only, no personal data) so the dashboard does not call Google
-- on every load.
-- ---------------------------------------------------------------------------
ALTER TABLE marketing_settings ADD COLUMN ga4_property_id TEXT
  CHECK (ga4_property_id IS NULL OR (ga4_property_id NOT GLOB '*[^0-9]*' AND length(ga4_property_id) BETWEEN 5 AND 20));

CREATE TABLE analytics_report_cache (
  cache_key  TEXT PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 100),
  payload    TEXT CHECK (payload IS NULL OR length(payload) <= 20000),
  error      TEXT CHECK (error IS NULL OR length(error) <= 300),
  fetched_at TEXT NOT NULL
) STRICT;
