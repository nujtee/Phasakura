import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface CustomFontRow {
  id: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  fallback: "SANS" | "ROUNDED" | "SERIF" | "MONO";
  media_asset_id: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

/** Uploaded web fonts (Phase 12). */
export class FontRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async list(): Promise<CustomFontRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT f.id, f.family, f.weight, f.style, f.fallback, f.media_asset_id, m.object_key, m.mime_type, m.size_bytes, f.created_at
           FROM custom_fonts f JOIN media_assets m ON m.id = f.media_asset_id AND m.status = 'ACTIVE'
          ORDER BY f.family, f.weight, f.style`,
      )
      .all<CustomFontRow>();
    return results;
  }

  async families(): Promise<string[]> {
    return [...new Set((await this.list()).map((f) => f.family))];
  }

  insertStatement(f: { id: string; family: string; weight: number; style: string; fallback: string; assetId: string; actorId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO custom_fonts (id, family, weight, style, fallback, media_asset_id, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(f.id, f.family, f.weight, f.style, f.fallback, f.assetId, f.now, f.actorId);
  }

  deleteStatement(id: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM custom_fonts WHERE id = ?1 RETURNING media_asset_id").bind(id);
  }

  /** Theme versions (draft or published) whose tokens mention a family. */
  async themesUsing(family: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM theme_versions
          WHERE status IN ('DRAFT', 'PUBLISHED') AND instr(tokens_json, ?1) > 0`,
      )
      .bind(JSON.stringify(`"${family}"`).slice(1, -1))
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
