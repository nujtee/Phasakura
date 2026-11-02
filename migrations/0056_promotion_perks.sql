-- Migration 0056: extra perks of promotions (ของแถม / สิทธิพิเศษ), a shared list like the amenities.
-- Non-destructive: three new tables and one nullable column. A rule without perks prices and shows as before.
--   promotion_perks              the shared list (deleted = INACTIVE, kept for history)
--   promotion_perk_translations  its names per language (Thai required by the app)
--   pricing_rule_perks           which perks a price rule's promotion gives
--   booking_promotions.perks_json  the perks a booking got, names frozen at booking time (shown on the bill)

CREATE TABLE promotion_perks (
  id         TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE promotion_perk_translations (
  perk_id       TEXT NOT NULL REFERENCES promotion_perks (id),
  language_code TEXT NOT NULL REFERENCES languages (code),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  PRIMARY KEY (perk_id, language_code)
) STRICT;

CREATE TABLE pricing_rule_perks (
  rule_id TEXT NOT NULL REFERENCES pricing_settings (id),
  perk_id TEXT NOT NULL REFERENCES promotion_perks (id),
  PRIMARY KEY (rule_id, perk_id)
) STRICT;

CREATE INDEX ix_pricing_rule_perks_perk ON pricing_rule_perks (perk_id);

ALTER TABLE booking_promotions ADD COLUMN perks_json TEXT CHECK (perks_json IS NULL OR json_valid(perks_json));
