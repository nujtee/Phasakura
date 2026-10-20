-- Migration 0035: send availability and prices to Channex (phase O3). Non-destructive: new columns, one new table.
--
-- channex_settings.ari_enabled: the push is OFF until staff start it (after checking the room mapping).
-- rate_markup_percent: OTA price = website price × (100 + markup) / 100 (OTAs take a commission).
-- channex_ari_state: what Channex was last told per house / VIP tent and night, so each minute only changes go out;
-- a full resend happens every night (Channex asks for one) and on "send everything now".
ALTER TABLE channex_settings ADD COLUMN ari_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ari_enabled IN (0, 1));
ALTER TABLE channex_settings ADD COLUMN rate_markup_percent INTEGER NOT NULL DEFAULT 0 CHECK (rate_markup_percent BETWEEN 0 AND 100);
ALTER TABLE channex_settings ADD COLUMN last_push_at TEXT;
ALTER TABLE channex_settings ADD COLUMN last_push_status TEXT CHECK (last_push_status IS NULL OR last_push_status IN ('OK', 'WARNING', 'ERROR'));
ALTER TABLE channex_settings ADD COLUMN last_push_error TEXT CHECK (last_push_error IS NULL OR length(last_push_error) <= 500);
ALTER TABLE channex_settings ADD COLUMN last_push_changes INTEGER CHECK (last_push_changes IS NULL OR last_push_changes >= 0);
ALTER TABLE channex_settings ADD COLUMN last_full_push_at TEXT;
ALTER TABLE channex_settings ADD COLUMN retry_after TEXT;

CREATE TABLE channex_ari_state (
  unit_id      TEXT NOT NULL REFERENCES accommodation_units (id),
  stay_date    TEXT NOT NULL CHECK (date(stay_date) = stay_date),
  availability INTEGER NOT NULL CHECK (availability IN (0, 1)),
  rate_satang  INTEGER CHECK (rate_satang IS NULL OR rate_satang >= 0),
  pushed_at    TEXT NOT NULL,
  PRIMARY KEY (unit_id, stay_date)
) STRICT;
