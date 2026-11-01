-- Migration 0055: promotions on price rules (ราคาตามช่วงเวลา → โปรโมชั่น).
-- Non-destructive: nullable / defaulted columns on pricing_settings and two new tables. A rule without any of them
-- prices nights exactly as before.
--   discount_kind / discount_value  room discount on the rule's price: PERCENT (1–90) or AMOUNT (satang per night).
--   free_extra_bed / free_pets      extra beds / pets cost nothing on the nights this rule prices.
--   promo_text                      what guests read about the promotion (booking page, house page, bill).
--   pricing_rule_free_foods         food options that are free (when the guest picks them) on the rule's dates.
--   booking_promotions              what a booking got from promotions, frozen at booking time (shown on the bill).

ALTER TABLE pricing_settings ADD COLUMN discount_kind TEXT CHECK (discount_kind IS NULL OR discount_kind IN ('PERCENT', 'AMOUNT'));
ALTER TABLE pricing_settings ADD COLUMN discount_value INTEGER CHECK (discount_value IS NULL OR discount_value >= 1);
ALTER TABLE pricing_settings ADD COLUMN free_extra_bed INTEGER NOT NULL DEFAULT 0 CHECK (free_extra_bed IN (0, 1));
ALTER TABLE pricing_settings ADD COLUMN free_pets INTEGER NOT NULL DEFAULT 0 CHECK (free_pets IN (0, 1));
ALTER TABLE pricing_settings ADD COLUMN promo_text TEXT CHECK (promo_text IS NULL OR length(promo_text) BETWEEN 1 AND 300);

CREATE TABLE pricing_rule_free_foods (
  rule_id   TEXT NOT NULL REFERENCES pricing_settings (id),
  option_id TEXT NOT NULL REFERENCES food_options (id),
  PRIMARY KEY (rule_id, option_id)
) STRICT;

CREATE TABLE booking_promotions (
  id                   TEXT PRIMARY KEY,
  booking_id           TEXT NOT NULL REFERENCES bookings (id),
  booking_item_id      TEXT REFERENCES booking_items (id),
  rule_id              TEXT,
  promo_text           TEXT CHECK (promo_text IS NULL OR length(promo_text) <= 300),
  room_discount_satang INTEGER NOT NULL DEFAULT 0 CHECK (room_discount_satang >= 0),
  extra_bed_free_satang INTEGER NOT NULL DEFAULT 0 CHECK (extra_bed_free_satang >= 0),
  pets_free_satang     INTEGER NOT NULL DEFAULT 0 CHECK (pets_free_satang >= 0),
  food_free_satang     INTEGER NOT NULL DEFAULT 0 CHECK (food_free_satang >= 0),
  created_at           TEXT NOT NULL
) STRICT;

CREATE INDEX ix_booking_promotions_booking ON booking_promotions (booking_id);
