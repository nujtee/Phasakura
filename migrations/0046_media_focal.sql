-- Migration 0046: focal point of an image (จุดสำคัญของรูป) — where to keep the picture when it is cropped to fill a frame.
-- Non-destructive: two nullable columns on media_assets (percent from the left / top, 0–100). NULL = centre, as before.
-- Found automatically by the admin's browser when the photo is uploaded; staff may move it by clicking on the photo.
-- The public pages draw it with CSS object-position, so the same file fits wide (computer) and tall (phone) frames.

ALTER TABLE media_assets ADD COLUMN focal_x INTEGER CHECK (focal_x IS NULL OR (focal_x BETWEEN 0 AND 100));
ALTER TABLE media_assets ADD COLUMN focal_y INTEGER CHECK (focal_y IS NULL OR (focal_y BETWEEN 0 AND 100));
