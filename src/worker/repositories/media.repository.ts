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
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256, uploaded_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(a.id, a.bucket, a.key, a.purpose, a.mime, a.size, a.width, a.height, a.sha256, a.uploadedBy, a.now);
  }

  findById(id: string): Promise<MediaAssetRow | null> {
    return this.db
      .prepare(
        `SELECT id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256, status
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

  markDeletedStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE media_assets SET status = 'DELETED', deleted_at = ?2 WHERE id = ?1 AND status = 'ACTIVE'")
      .bind(id, now);
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
