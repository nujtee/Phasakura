import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export type MediaPurpose =
  | "LOGO" | "FAVICON" | "FONT" | "HOME_SLIDE" | "HOME_SECTION" | "GALLERY" | "HISTORY"
  | "ACCOMMODATION" | "FOOD" | "PAYMENT_QR" | "PAYMENT_SLIP" | "OG_IMAGE" | "OTHER";

export interface MediaAssetRow {
  id: string;
  bucket: "PUBLIC" | "PRIVATE";
  object_key: string;
  purpose: MediaPurpose;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  status: "ACTIVE" | "DELETED";
  parent_asset_id?: string | null;
}

/** A public asset with the result of the "may the public see it?" check (Phase 12). */
export interface ServableAssetRow extends MediaAssetRow {
  is_public: number;
}

export interface MediaTranslationRow {
  media_asset_id: string;
  language_code: string;
  alt_text: string | null;
  title: string | null;
  caption: string | null;
}

export class MediaRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  insertStatement(a: {
    id: string;
    bucket: "PUBLIC" | "PRIVATE";
    key: string;
    purpose: MediaPurpose;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    sha256: string;
    uploadedBy: string | null;
    now: string;
    /** Rendition of this original (Phase 12). */
    parentId?: string | null;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256, uploaded_by, created_at, parent_asset_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(a.id, a.bucket, a.key, a.purpose, a.mime, a.size, a.width, a.height, a.sha256, a.uploadedBy, a.now, a.parentId ?? null);
  }

  findById(id: string): Promise<MediaAssetRow | null> {
    return this.db
      .prepare(
        `SELECT id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256, status, parent_asset_id
           FROM media_assets WHERE id = ?1`,
      )
      .bind(id)
      .first<MediaAssetRow>();
  }

  /** Only ACTIVE assets in the PUBLIC bucket are ever served without authentication. */
  findPublicByKey(key: string): Promise<MediaAssetRow | null> {
    return this.db
      .prepare(
        `SELECT id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256, status
           FROM media_assets WHERE bucket = 'PUBLIC' AND object_key = ?1 AND status = 'ACTIVE'`,
      )
      .bind(key)
      .first<MediaAssetRow>();
  }

  /** Retires an original and its renditions. */
  markDeletedStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE media_assets SET status = 'DELETED', deleted_at = ?2 WHERE (id = ?1 OR parent_asset_id = ?1) AND status = 'ACTIVE'")
      .bind(id, now);
  }

  /** R2 keys of an original and its renditions (to delete the objects after the asset is retired). */
  async objectKeys(id: string): Promise<{ bucket: "PUBLIC" | "PRIVATE"; object_key: string }[]> {
    const { results } = await this.db
      .prepare("SELECT bucket, object_key FROM media_assets WHERE id = ?1 OR parent_asset_id = ?1")
      .bind(id)
      .all<{ bucket: "PUBLIC" | "PRIVATE"; object_key: string }>();
    return results;
  }

  /**
   * Public media access control (spec §10 "only PUBLISHED is public", §54–55): an ACTIVE public asset
   * with `is_public` = 1 when what uses it is visible to visitors. Renditions follow their original.
   * Brand files, fonts, social images and payment QR codes are always public.
   */
  findServable(key: string, now: string): Promise<ServableAssetRow | null> {
    const root = "COALESCE(a.parent_asset_id, a.id)";
    return this.db
      .prepare(
        `SELECT a.id, a.bucket, a.object_key, a.purpose, a.mime_type, a.size_bytes, a.width, a.height, a.sha256, a.status, a.parent_asset_id,
                CASE
                  WHEN a.purpose IN ('LOGO', 'FAVICON', 'FONT', 'OG_IMAGE', 'PAYMENT_QR', 'OTHER') THEN 1
                  WHEN a.purpose = 'GALLERY' THEN EXISTS (
                    SELECT 1 FROM gallery_images g LEFT JOIN gallery_categories c ON c.id = g.category_id
                     WHERE g.media_asset_id = ${root} AND g.status = 'PUBLISHED' AND (g.category_id IS NULL OR c.status = 'PUBLISHED'))
                  WHEN a.purpose = 'HOME_SLIDE' THEN EXISTS (
                    SELECT 1 FROM home_slides s
                     WHERE (s.desktop_asset_id = ${root} OR s.mobile_asset_id = ${root}) AND s.status IN ('PUBLISHED', 'SCHEDULED')
                       AND (s.start_at IS NULL OR s.start_at <= ?2) AND (s.end_at IS NULL OR s.end_at > ?2))
                  WHEN a.purpose = 'HOME_SECTION' THEN EXISTS (
                    SELECT 1 FROM home_sections s WHERE s.media_asset_id = ${root} AND s.status = 'PUBLISHED')
                  WHEN a.purpose = 'HISTORY' THEN EXISTS (
                    SELECT 1 FROM history_sections s WHERE s.media_asset_id = ${root} AND s.status = 'PUBLISHED')
                    OR EXISTS (SELECT 1 FROM history_timeline h WHERE h.media_asset_id = ${root} AND h.status = 'PUBLISHED')
                  WHEN a.purpose = 'ACCOMMODATION' THEN EXISTS (
                    SELECT 1 FROM accommodation_images i JOIN accommodation_units u ON u.id = i.unit_id
                     WHERE i.media_asset_id = ${root} AND i.status = 'PUBLISHED' AND u.status = 'ACTIVE')
                    OR EXISTS (SELECT 1 FROM accommodation_units u WHERE u.cover_asset_id = ${root} AND u.status = 'ACTIVE')
                    OR EXISTS (SELECT 1 FROM camping_settings c WHERE c.cover_asset_id = ${root} AND c.is_enabled = 1)
                  WHEN a.purpose = 'FOOD' THEN EXISTS (
                    SELECT 1 FROM food_options o WHERE o.image_asset_id = ${root} AND o.status = 'ACTIVE')
                    OR EXISTS (SELECT 1 FROM food_images f JOIN food_options o ON o.id = f.food_option_id
                                WHERE f.media_asset_id = ${root} AND o.status = 'ACTIVE')
                  ELSE 0
                END AS is_public
           FROM media_assets a WHERE a.bucket = 'PUBLIC' AND a.object_key = ?1 AND a.status = 'ACTIVE'`,
      )
      .bind(key, now)
      .first<ServableAssetRow>();
  }

  upsertTranslationStatement(t: {
    mediaAssetId: string;
    languageCode: string;
    altText: string | null;
    title: string | null;
    caption: string | null;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO media_asset_translations (media_asset_id, language_code, alt_text, title, caption)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (media_asset_id, language_code)
         DO UPDATE SET alt_text = excluded.alt_text, title = excluded.title, caption = excluded.caption`,
      )
      .bind(t.mediaAssetId, t.languageCode, t.altText, t.title, t.caption);
  }

  async translationsFor(ids: string[]): Promise<MediaTranslationRow[]> {
    if (ids.length === 0) return [];
    const { results } = await this.db
      .prepare(
        `SELECT media_asset_id, language_code, alt_text, title, caption FROM media_asset_translations
          WHERE media_asset_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(ids))
      .all<MediaTranslationRow>();
    return results;
  }
}
