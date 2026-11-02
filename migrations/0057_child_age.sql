-- Migration 0057: the age under which a guest counts as a child, set in Admin (booking rules).
-- Non-destructive: one nullable column. NULL = as before (the camping setting "children under … stay free", else 12).
ALTER TABLE booking_settings ADD COLUMN child_max_age INTEGER CHECK (child_max_age IS NULL OR child_max_age BETWEEN 1 AND 18);
