-- Migration 0048: zoom of an image in its frame (ซูมเข้า/ออก), next to the focal point of 0046.
-- Non-destructive: one nullable column on media_assets, percent (100 = the photo just fills the frame, up to 300).
-- The home slideshow scales the photo around its focal point; NULL = 100 %, as before.

ALTER TABLE media_assets ADD COLUMN zoom INTEGER CHECK (zoom IS NULL OR (zoom BETWEEN 100 AND 300));
