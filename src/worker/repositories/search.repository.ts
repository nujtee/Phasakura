import type { SearchEntityType } from "../../shared/search-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface IndexDoc {
  id: string;
  type: SearchEntityType;
  entityId: string;
  lang: string;
  title: string;
  summary: string | null;
  keywords: string | null;
  text: string;
  url: string;
  boost: number;
}

export interface MatchRow {
  entity_type: SearchEntityType;
  entity_id: string;
  language_code: string;
  title: string;
  url_path: string;
  boost: number;
}

/** JSON chunks for INSERT … SELECT FROM json_each(?) stay well under D1's statement / parameter limits. */
const CHUNK_BYTES = 80_000;

const len = (cols: string) => cols.split(",").map((c) => `coalesce(length(${c.trim()}), 0)`).join(" + ");

/**
 * Source-table fingerprint: row counts, last updates and text lengths of everything the index is
 * built from. When it changes, the index is rebuilt (static SQL, no input).
 */
const FINGERPRINT_SQL = `SELECT
  (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(group_concat(status), '') FROM accommodation_units) || '|' ||
  (SELECT count(*) || ':' || total(${len("name, short_description, description")}) FROM accommodation_translations) || '|' ||
  (SELECT count(*) || ':' || total(${len("name")}) FROM amenity_translations) || '|' ||
  (SELECT count(*) FROM accommodation_amenities) || '|' ||
  (SELECT coalesce(max(updated_at), '') || ':' || coalesce(max(is_enabled), 0) FROM camping_settings) || '|' ||
  (SELECT count(*) || ':' || total(${len("name, description")}) FROM camping_setting_translations) || '|' ||
  (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(group_concat(status), '') FROM food_options) || '|' ||
  (SELECT count(*) || ':' || coalesce(group_concat(status), '') FROM food_categories) || '|' ||
  (SELECT count(*) || ':' || total(${len("name, description, allergens")}) FROM food_option_translations) || '|' ||
  (SELECT count(*) || ':' || total(${len("name, description")}) FROM food_category_translations) || '|' ||
  (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(group_concat(status), '') FROM history_sections) || '|' ||
  (SELECT count(*) || ':' || total(${len("title, subtitle, body")}) FROM history_translations) || '|' ||
  (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(group_concat(status), '') FROM history_timeline) || '|' ||
  (SELECT count(*) || ':' || total(${len("title, description")}) FROM history_timeline_translations) || '|' ||
  (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(group_concat(status), '') FROM gallery_images) || '|' ||
  (SELECT count(*) || ':' || total(${len("alt_text, title, caption")}) FROM gallery_image_translations) || '|' ||
  (SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(group_concat(status), '') FROM gallery_categories) || '|' ||
  (SELECT count(*) || ':' || total(${len("name")}) FROM gallery_category_translations) AS fingerprint`;

/** Search index, history and analytics (spec §40–41). Index rows are a rebuildable projection. */
export class SearchRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async fingerprint(): Promise<string> {
    const row = await this.db.prepare(FINGERPRINT_SQL).first<{ fingerprint: string | null }>();
    return row?.fingerprint ?? "";
  }

  state(): Promise<{ fingerprint: string; rows_count: number; rebuilt_at: string } | null> {
    return this.db.prepare("SELECT fingerprint, rows_count, rebuilt_at FROM search_index_state WHERE id = 1")
      .first<{ fingerprint: string; rows_count: number; rebuilt_at: string }>();
  }

  /** Whole index replaced in one batch (atomic): readers never see a half-built index. */
  replaceStatements(docs: IndexDoc[], fingerprint: string, now: string): D1PreparedStatementLike[] {
    const statements = [this.db.prepare("DELETE FROM search_index")];
    let chunk: IndexDoc[] = [];
    let size = 0;
    const flush = () => {
      if (!chunk.length) return;
      statements.push(this.db.prepare(
        `INSERT INTO search_index (id, entity_type, entity_id, language_code, title, summary, keywords, normalized_text, url_path,
                                   boost, is_active, indexed_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.type'), json_extract(value, '$.entityId'),
                json_extract(value, '$.lang'), json_extract(value, '$.title'), json_extract(value, '$.summary'),
                json_extract(value, '$.keywords'), json_extract(value, '$.text'), json_extract(value, '$.url'),
                json_extract(value, '$.boost'), 1, ?2
           FROM json_each(?1)`,
      ).bind(JSON.stringify(chunk), now));
      chunk = [];
      size = 0;
    };
    for (const d of docs) {
      const bytes = JSON.stringify(d).length;
      if (size + bytes > CHUNK_BYTES) flush();
      chunk.push(d);
      size += bytes;
    }
    flush();
    statements.push(this.db.prepare(
      `INSERT INTO search_index_state (id, fingerprint, rows_count, rebuilt_at) VALUES (1, ?1, ?2, ?3)
       ON CONFLICT (id) DO UPDATE SET fingerprint = excluded.fingerprint, rows_count = excluded.rows_count, rebuilt_at = excluded.rebuilt_at`,
    ).bind(fingerprint, docs.length, now));
    return statements;
  }

  /**
   * Rows (any language) whose text contains every token. The SQL shape depends only on the
   * number of tokens (1–6); the tokens themselves are bound parameters.
   */
  async match(tokens: string[], limit: number): Promise<MatchRow[]> {
    if (!tokens.length) return [];
    const conditions = tokens.map((_, i) => `instr(normalized_text, ?${i + 1}) > 0`).join(" AND ");
    const { results } = await this.db
      .prepare(
        `SELECT entity_type, entity_id, language_code, title, url_path, boost FROM search_index
          WHERE is_active = 1 AND ${conditions}
          LIMIT ${Math.max(1, Math.min(1000, Math.floor(limit)))}`,
      )
      .bind(...tokens)
      .all<MatchRow>();
    return results;
  }

  /** One search: anonymous history row (no IP, no user) + the day's aggregate. */
  logStatements(input: { id: string; query: string; normalized: string; lang: string; checkIn: string | null; checkOut: string | null;
    results: number; day: string; now: string }): D1PreparedStatementLike[] {
    return [
      this.db.prepare(
        `INSERT INTO search_history (id, query, language_code, check_in, check_out, results_count, session_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
      ).bind(input.id, input.query, input.lang, input.checkIn, input.checkOut, input.results, input.now),
      this.db.prepare(
        `INSERT INTO search_analytics (query_normalized, language_code, search_date, search_count, zero_result_count, click_count)
         VALUES (?1, ?2, ?3, 1, ?4, 0)
         ON CONFLICT (query_normalized, language_code, search_date) DO UPDATE SET
           search_count = search_count + 1, zero_result_count = zero_result_count + excluded.zero_result_count`,
      ).bind(input.normalized, input.lang, input.day, input.results === 0 ? 1 : 0),
    ];
  }

  /** A result was opened: counted on that day's row for the query (only if it was searched). */
  async click(normalized: string, lang: string, day: string): Promise<void> {
    await this.db.prepare(
      `UPDATE search_analytics SET click_count = min(click_count + 1, search_count)
        WHERE query_normalized = ?1 AND language_code = ?2 AND search_date = ?3`,
    ).bind(normalized, lang, day).run();
  }

  async analytics(since: string): Promise<{
    top: { query_normalized: string; language_code: string; searches: number; zero: number; clicks: number }[];
    zero: { query_normalized: string; language_code: string; searches: number }[];
  }> {
    const [top, zero] = await this.db.batch([
      this.db.prepare(
        `SELECT query_normalized, language_code, sum(search_count) AS searches, sum(zero_result_count) AS zero, sum(click_count) AS clicks
           FROM search_analytics WHERE search_date >= ?1 AND query_normalized <> ''
          GROUP BY query_normalized, language_code ORDER BY searches DESC, query_normalized LIMIT 20`,
      ).bind(since),
      this.db.prepare(
        `SELECT query_normalized, language_code, sum(zero_result_count) AS searches
           FROM search_analytics WHERE search_date >= ?1 AND query_normalized <> ''
          GROUP BY query_normalized, language_code HAVING sum(zero_result_count) > 0
          ORDER BY searches DESC, query_normalized LIMIT 20`,
      ).bind(since),
    ]);
    return {
      top: (top?.results ?? []) as { query_normalized: string; language_code: string; searches: number; zero: number; clicks: number }[],
      zero: (zero?.results ?? []) as { query_normalized: string; language_code: string; searches: number }[],
    };
  }

  /** History older than the retention window (anonymous, but kept short anyway). */
  purgeHistoryStatement(before: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM search_history WHERE created_at < ?1").bind(before);
  }
}
