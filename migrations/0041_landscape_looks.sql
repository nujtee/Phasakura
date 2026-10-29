-- Migration 0041: Landscape looks — a palette kind can say which illustrated "3D" look new objects get (a Thai house,
-- a bell tent, a pine…). Non-destructive: one nullable column. The look of a drawn object lives in the plan itself.

ALTER TABLE landscape_palette ADD COLUMN look TEXT CHECK (look IS NULL OR length(look) BETWEEN 1 AND 24);
