-- Migration 0011: camping capacity overrides (non-destructive: ADD COLUMN only)
--
-- camping_night_inventory rows are created on demand with the default capacity.
-- is_override = 1 marks a date whose capacity an admin set explicitly; those dates
-- are NOT changed when the default max_tents_per_night changes. All other future
-- dates follow the new default (the existing CHECK still rejects going below
-- tents already sold, rolling back the whole change).

ALTER TABLE camping_night_inventory
  ADD COLUMN is_override INTEGER NOT NULL DEFAULT 0 CHECK (is_override IN (0, 1));

CREATE INDEX ix_camping_night_inventory_override ON camping_night_inventory (is_override, stay_date);
