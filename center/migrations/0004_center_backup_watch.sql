-- Fix (phase C9): "no backup yet" must count from when Center could first READ a site's backup list, not from the
-- first health check (sites watched for days before backups existed were flagged at once).
-- NULL = the list could not be read in that check; 'ok' | 'empty' | 'stale' otherwise.
ALTER TABLE center_site_checks ADD COLUMN backup_state TEXT CHECK (backup_state IS NULL OR backup_state IN ('ok', 'empty', 'stale'));
