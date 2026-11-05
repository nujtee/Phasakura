-- Migration 0060: credit settings managed from Center (one set for every site).
-- Center pushes the shared credit settings (fee, threshold, approval mode, plan minimums, where top-ups are paid,
-- notices) to each site; the site then shows them read-only. On / off stays per site. Additive: three columns,
-- no data changes — a site keeps its own settings until Center first sends a set.
ALTER TABLE credit_settings ADD COLUMN center_managed INTEGER NOT NULL DEFAULT 0 CHECK (center_managed IN (0, 1));
ALTER TABLE credit_settings ADD COLUMN center_version TEXT CHECK (center_version IS NULL OR length(center_version) BETWEEN 1 AND 64);
ALTER TABLE credit_settings ADD COLUMN center_synced_at TEXT;
