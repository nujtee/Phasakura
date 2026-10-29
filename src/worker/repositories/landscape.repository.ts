import type { LandscapeBackgroundKind } from "../../shared/landscape-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { isMissingSchema } from "./inventory.repository.ts";

export interface LandscapeSettingsRow {
  enabled: number;
  public_layout_id: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface LandscapeLayoutRow {
  id: string;
  name: string;
  background_kind: LandscapeBackgroundKind;
  draft_json: string;
  draft_revision: number;
  draft_updated_by: string | null;
  draft_updated_by_name: string | null;
  draft_updated_at: string;
  published_version_id: string | null;
  published_version_no: number | null;
  published_at: string | null;
  published_json: string | null;
  status: "ACTIVE" | "ARCHIVED";
}

export interface LandscapeVersionRow {
  id: string;
  layout_id: string;
  version_no: number;
  document_json: string;
  note: string | null;
  restored_from_no: number | null;
  published_by_name: string | null;
  published_at: string;
}

export interface LandscapePaletteRow {
  id: string;
  builtin: number;
  kind: string;
  name: string | null;
  draw: string | null;
  fill: string | null;
  stroke: string | null;
  opacity: number | null;
  layer: string | null;
  size: number | null;
  palette_group: string | null;
  sort_order: number | null;
  hidden: number;
  look: string | null;
}

export interface LandscapeTemplateRow {
  id: string;
  name: string;
  object_json: string;
}

const LAYOUT_SELECT = `
  SELECT l.id, l.name, l.background_kind, l.draft_json, l.draft_revision, l.draft_updated_by, du.display_name AS draft_updated_by_name,
         l.draft_updated_at, l.published_version_id, v.version_no AS published_version_no, v.published_at, v.document_json AS published_json,
         l.status
    FROM landscape_layouts l
    LEFT JOIN users du ON du.id = l.draft_updated_by
    LEFT JOIN landscape_versions v ON v.id = l.published_version_id`;

/** Landscape layouts, versions and the switch (migration 0039). Statements are composed into batches by the service. */
export class LandscapeRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** null before migration 0039. */
  async settings(): Promise<LandscapeSettingsRow | null> {
    try {
      return await this.db.prepare("SELECT enabled, public_layout_id, updated_by, updated_at FROM landscape_settings WHERE id = 1")
        .first<LandscapeSettingsRow>();
    } catch (error) {
      if (isMissingSchema(error)) return null;
      throw error;
    }
  }

  setEnabledStatement(enabled: boolean, userId: string | null, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE landscape_settings SET enabled = ?1, updated_by = ?2, updated_at = ?3 WHERE id = 1")
      .bind(enabled ? 1 : 0, userId, now);
  }

  /** The layout the booking page shows: only an ACTIVE layout with a published version. */
  setPublicStatement(layoutId: string | null, userId: string, now: string, onlyIfVersion: string | null = null): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE landscape_settings SET public_layout_id = ?1, updated_by = ?2, updated_at = ?3
          WHERE id = 1 AND (?1 IS NULL OR EXISTS (SELECT 1 FROM landscape_layouts
                                                  WHERE id = ?1 AND status = 'ACTIVE' AND published_version_id IS NOT NULL))
            AND (?4 IS NULL OR EXISTS (SELECT 1 FROM landscape_versions WHERE id = ?4))
          RETURNING id`,
      )
      .bind(layoutId, userId, now, onlyIfVersion);
  }

  async layouts(): Promise<LandscapeLayoutRow[]> {
    const { results } = await this.db.prepare(`${LAYOUT_SELECT} WHERE l.status = 'ACTIVE' ORDER BY l.created_at, l.id`).all<LandscapeLayoutRow>();
    return results;
  }

  /** Settings → Website latitude / longitude: where a new satellite plan starts. */
  async siteLocation(): Promise<[number, number] | null> {
    const row = await this.db.prepare("SELECT latitude, longitude FROM site_settings WHERE id = 1").first<{ latitude: number | null; longitude: number | null }>();
    return row && row.latitude !== null && row.longitude !== null ? [row.longitude, row.latitude] : null;
  }

  /**
   * Centre and zoom of every active satellite plan (draft and published) while the feature is on: the only places
   * map tiles are fetched for (phase L4). Read with json_extract, not by loading whole plans.
   */
  async satelliteAreas(): Promise<{ lon: number; lat: number; zoom: number }[]> {
    const { results } = await this.db.prepare(`
      SELECT json_extract(l.draft_json, '$.background.center[0]') AS lon, json_extract(l.draft_json, '$.background.center[1]') AS lat,
             json_extract(l.draft_json, '$.background.zoom') AS zoom
        FROM landscape_layouts l JOIN landscape_settings s ON s.id = 1 AND s.enabled = 1
       WHERE l.status = 'ACTIVE' AND l.background_kind = 'SATELLITE'
      UNION ALL
      SELECT json_extract(v.document_json, '$.background.center[0]'), json_extract(v.document_json, '$.background.center[1]'),
             json_extract(v.document_json, '$.background.zoom')
        FROM landscape_layouts l JOIN landscape_versions v ON v.id = l.published_version_id
        JOIN landscape_settings s ON s.id = 1 AND s.enabled = 1
       WHERE l.status = 'ACTIVE' AND l.background_kind = 'SATELLITE'`).all<{ lon: number | null; lat: number | null; zoom: number | null }>();
    return results.filter((r): r is { lon: number; lat: number; zoom: number } =>
      typeof r.lon === "number" && typeof r.lat === "number" && typeof r.zoom === "number");
  }

  layout(id: string): Promise<LandscapeLayoutRow | null> {
    return this.db.prepare(`${LAYOUT_SELECT} WHERE l.id = ?1 AND l.status = 'ACTIVE'`).bind(id).first<LandscapeLayoutRow>();
  }

  insertLayoutStatement(l: { id: string; name: string; kind: LandscapeBackgroundKind; json: string; userId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO landscape_layouts (id, name, background_kind, draft_json, draft_revision, draft_updated_by, draft_updated_at, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?5, ?6)`,
      )
      .bind(l.id, l.name, l.kind, l.json, l.userId, l.now);
  }

  /** Saves a draft only on top of the revision the editor started from; RETURNING the new revision (none = conflict). */
  saveDraftStatement(d: { id: string; baseRevision: number; json: string; name: string; userId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE landscape_layouts SET draft_json = ?3, name = ?4, draft_revision = draft_revision + 1, draft_updated_by = ?5, draft_updated_at = ?6
          WHERE id = ?1 AND status = 'ACTIVE' AND draft_revision = ?2
          RETURNING draft_revision`,
      )
      .bind(d.id, d.baseRevision, d.json, d.name, d.userId, d.now);
  }

  archiveStatement(id: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE landscape_layouts SET status = 'ARCHIVED' WHERE id = ?1 AND status = 'ACTIVE' RETURNING id").bind(id);
  }

  /** The booking page stops showing an archived layout (same batch). */
  clearPublicIfStatement(layoutId: string, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE landscape_settings SET public_layout_id = NULL, updated_at = ?2 WHERE id = 1 AND public_layout_id = ?1")
      .bind(layoutId, now);
  }

  /**
   * A new version (number = last + 1) and the layout pointing at it — only while the draft is still at `revision`
   * (nobody saved after the publisher looked at it). Statement 1 RETURNs the version id when it was written.
   */
  publishStatements(p: { versionId: string; layoutId: string; revision: number | null; json: string; note: string | null; restoredFrom: string | null; userId: string; now: string }): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare(
          `INSERT INTO landscape_versions (id, layout_id, version_no, document_json, note, restored_from, published_by, published_at)
           SELECT ?1, ?2, COALESCE((SELECT MAX(version_no) FROM landscape_versions WHERE layout_id = ?2), 0) + 1, ?4, ?5, ?6, ?7, ?8
            WHERE EXISTS (SELECT 1 FROM landscape_layouts WHERE id = ?2 AND status = 'ACTIVE' AND (?3 IS NULL OR draft_revision = ?3))
           RETURNING id`,
        )
        .bind(p.versionId, p.layoutId, p.revision, p.json, p.note, p.restoredFrom, p.userId, p.now),
      this.db
        .prepare("UPDATE landscape_layouts SET published_version_id = ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM landscape_versions WHERE id = ?1)")
        .bind(p.versionId, p.layoutId),
    ];
  }

  async versions(layoutId: string): Promise<LandscapeVersionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT v.id, v.layout_id, v.version_no, v.document_json, v.note, r.version_no AS restored_from_no, u.display_name AS published_by_name, v.published_at
           FROM landscape_versions v
           LEFT JOIN landscape_versions r ON r.id = v.restored_from
           LEFT JOIN users u ON u.id = v.published_by
          WHERE v.layout_id = ?1 ORDER BY v.version_no DESC LIMIT 100`,
      )
      .bind(layoutId)
      .all<LandscapeVersionRow>();
    return results;
  }

  version(id: string): Promise<LandscapeVersionRow | null> {
    return this.db
      .prepare(
        `SELECT v.id, v.layout_id, v.version_no, v.document_json, v.note, NULL AS restored_from_no, NULL AS published_by_name, v.published_at
           FROM landscape_versions v WHERE v.id = ?1`,
      )
      .bind(id)
      .first<LandscapeVersionRow>();
  }

  /** Units a HOUSE / VIP_TENT object can point at (name in Thai, else the code). */
  async units(): Promise<{ id: string; unit_code: string; unit_type: "HOUSE" | "VIP_TENT"; status: string; name: string }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.unit_code, u.unit_type, u.status,
                COALESCE((SELECT name FROM accommodation_translations t WHERE t.unit_id = u.id AND t.language_code = 'th'), u.unit_code) AS name
           FROM accommodation_units u WHERE u.status <> 'DELETED' ORDER BY u.unit_type, u.sort_order, u.unit_code`,
      )
      .all<{ id: string; unit_code: string; unit_type: "HOUSE" | "VIP_TENT"; status: string; name: string }>();
    return results;
  }

  async campingEnabled(): Promise<boolean> {
    return (await this.db.prepare("SELECT is_enabled FROM camping_settings WHERE id = 1").first<{ is_enabled: number }>())?.is_enabled === 1;
  }

  /** A public image the plan may use as background / template picture. */
  async publicImage(id: string): Promise<{ object_key: string; width: number | null; height: number | null } | null> {
    return this.db
      .prepare(
        `SELECT object_key, width, height FROM media_assets
          WHERE id = ?1 AND status = 'ACTIVE' AND bucket = 'PUBLIC' AND parent_asset_id IS NULL
            AND mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')`,
      )
      .bind(id)
      .first<{ object_key: string; width: number | null; height: number | null }>();
  }

  async templates(): Promise<LandscapeTemplateRow[]> {
    const { results } = await this.db
      .prepare("SELECT id, name, object_json FROM landscape_templates WHERE status = 'ACTIVE' ORDER BY name, id LIMIT 200")
      .all<LandscapeTemplateRow>();
    return results;
  }

  insertTemplateStatement(t: { id: string; name: string; json: string; userId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare("INSERT INTO landscape_templates (id, name, object_json, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(t.id, t.name, t.json, t.userId, t.now);
  }

  deleteTemplateStatement(id: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE landscape_templates SET status = 'DELETED' WHERE id = ?1 AND status = 'ACTIVE' RETURNING id").bind(id);
  }

  // ---------------------------------------------------------------- palette (migration 0040)

  async palette(): Promise<LandscapePaletteRow[]> {
    const { results } = await this.db.prepare(
      `SELECT id, builtin, kind, name, draw, fill, stroke, opacity, layer, size, palette_group, sort_order, hidden, look
         FROM landscape_palette WHERE status = 'ACTIVE' ORDER BY builtin DESC, sort_order, name, id`,
    ).all<LandscapePaletteRow>();
    return results;
  }

  paletteRow(id: string): Promise<LandscapePaletteRow | null> {
    return this.db.prepare(
      `SELECT id, builtin, kind, name, draw, fill, stroke, opacity, layer, size, palette_group, sort_order, hidden, look
         FROM landscape_palette WHERE id = ?1 AND status = 'ACTIVE'`,
    ).bind(id).first<LandscapePaletteRow>();
  }

  async customKinds(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM landscape_palette WHERE builtin = 0 AND status = 'ACTIVE'").first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Saves a palette entry whole (an override of a built-in, or a staff kind); a deleted one with the id comes back. */
  upsertPaletteStatement(r: Omit<LandscapePaletteRow, "builtin"> & { builtin: 0 | 1 }, userId: string, now: string): D1PreparedStatementLike {
    return this.db.prepare(
      `INSERT INTO landscape_palette (id, builtin, kind, name, draw, fill, stroke, opacity, layer, size, palette_group, sort_order, hidden, look, status, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?16, 'ACTIVE', ?14, ?15)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, draw = excluded.draw, fill = excluded.fill,
         stroke = excluded.stroke, opacity = excluded.opacity, layer = excluded.layer, size = excluded.size,
         palette_group = excluded.palette_group, sort_order = excluded.sort_order, hidden = excluded.hidden, look = excluded.look, status = 'ACTIVE',
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(r.id, r.builtin, r.kind, r.name, r.draw, r.fill, r.stroke, r.opacity, r.layer, r.size, r.palette_group, r.sort_order, r.hidden, userId, now, r.look);
  }

  /** Built-in: its override goes (back to how it ships). Staff kind: marked deleted (drawn objects keep their look). */
  removePaletteStatement(id: string, builtin: boolean, userId: string, now: string): D1PreparedStatementLike {
    return builtin
      ? this.db.prepare("DELETE FROM landscape_palette WHERE id = ?1 AND builtin = 1 RETURNING id").bind(id)
      : this.db.prepare("UPDATE landscape_palette SET status = 'DELETED', updated_by = ?2, updated_at = ?3 WHERE id = ?1 AND builtin = 0 AND status = 'ACTIVE' RETURNING id")
        .bind(id, userId, now);
  }

  /** How many objects of active plans (drafts) were drawn as this palette entry. */
  async paletteUsage(id: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COALESCE(SUM((length(draft_json) - length(replace(draft_json, ?1, ''))) / length(?1)), 0) AS n
         FROM landscape_layouts WHERE status = 'ACTIVE'`,
    ).bind(`"typeId":"${id}"`).first<{ n: number }>();
    return row?.n ?? 0;
  }
}
