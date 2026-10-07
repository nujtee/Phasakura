-- Migration 0009: search (optimization only — never a source of truth, spec §41)
--
-- search_index is a denormalized, rebuildable projection of public content.
-- Availability, prices and capacity are ALWAYS read from the source tables.
-- It can later be replaced by Meilisearch / Typesense / Algolia behind the same
-- SearchIndex interface without changing business logic.

CREATE TABLE search_index (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL CHECK (entity_type IN (
                    'HOUSE', 'VIP_TENT', 'CAMPING', 'FOOD', 'ACTIVITY', 'PROMOTION', 'FAQ',
                    'HISTORY', 'GALLERY', 'ARTICLE')),
  entity_id       TEXT NOT NULL,
  language_code   TEXT NOT NULL REFERENCES languages (code),
  title           TEXT NOT NULL,
  summary         TEXT,
  keywords        TEXT,
  normalized_text TEXT NOT NULL,          -- lowercased, whitespace-collapsed text used for matching
  url_path        TEXT NOT NULL CHECK (url_path GLOB '/*' AND url_path NOT GLOB '//*'),
  image_asset_id  TEXT REFERENCES media_assets (id),
  boost           INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  indexed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (entity_type, entity_id, language_code)
) STRICT;

CREATE INDEX ix_search_index_lang_active ON search_index (language_code, is_active);
CREATE INDEX ix_search_index_entity ON search_index (entity_type, entity_id);
CREATE INDEX ix_search_index_entity_type ON search_index (entity_type, language_code, is_active);

-- Individual searches (no PII: no IP, no user id; session is an anonymous hash).
CREATE TABLE search_history (
  id             TEXT PRIMARY KEY,
  query          TEXT NOT NULL CHECK (length(query) <= 200),
  language_code  TEXT NOT NULL REFERENCES languages (code),
  check_in       TEXT CHECK (check_in IS NULL OR date(check_in) = check_in),
  check_out      TEXT CHECK (check_out IS NULL OR date(check_out) = check_out),
  results_count  INTEGER NOT NULL DEFAULT 0 CHECK (results_count >= 0),
  session_hash   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_search_history_created ON search_history (created_at);

-- Daily aggregate for the dashboard.
CREATE TABLE search_analytics (
  query_normalized   TEXT NOT NULL CHECK (length(query_normalized) <= 200),
  language_code      TEXT NOT NULL REFERENCES languages (code),
  search_date        TEXT NOT NULL CHECK (date(search_date) = search_date),
  search_count       INTEGER NOT NULL DEFAULT 0 CHECK (search_count >= 0),
  zero_result_count  INTEGER NOT NULL DEFAULT 0 CHECK (zero_result_count >= 0),
  click_count        INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  PRIMARY KEY (query_normalized, language_code, search_date),
  CHECK (zero_result_count <= search_count)
) STRICT;

CREATE INDEX ix_search_analytics_date ON search_analytics (search_date);
