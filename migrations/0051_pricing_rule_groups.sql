-- Migration 0051: one price rule for several chosen houses / VIP tents (กลุ่ม: เลือกหลายหลัง).
-- Non-destructive: one nullable column on pricing_settings. A group is stored as one UNIT rule per house sharing a
-- group_id, so the price engine is unchanged (it still reads UNIT rules); admin edits the group as one rule.
-- NULL = a rule on its own, as before.

ALTER TABLE pricing_settings ADD COLUMN group_id TEXT CHECK (group_id IS NULL OR length(group_id) BETWEEN 1 AND 64);

CREATE INDEX ix_pricing_settings_group ON pricing_settings (group_id) WHERE group_id IS NOT NULL;
