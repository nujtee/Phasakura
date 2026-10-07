-- Migration 0018: search index bookkeeping (Phase 13)
-- Non-destructive: one new singleton table, one index. No change to existing tables or data.
--
-- search_index (0009) stays a rebuildable projection of public content. This row records what it
-- was built from (a fingerprint of the source tables), so the cron rebuilds it only after content
-- changed — and at least once a day as a safety net.

CREATE TABLE search_index_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,
  rows_count  INTEGER NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  rebuilt_at  TEXT NOT NULL
) STRICT;

-- Admin "top searches" over a date range.
CREATE INDEX ix_search_analytics_lang_date ON search_analytics (language_code, search_date);
