import { DEFAULT_LOCALE_CODE } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike } from "../env.ts";
import { publicMediaUrl } from "../services/media-url.ts";

export interface Rendition {
  key: string;
  width: number;
}

/**
 * Responsive images (Phase 12): renditions are media_assets rows whose parent is the original.
 * One query loads the renditions of every image on a page; `srcset` lists them plus the original.
 */
export class ImageResolver {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly mediaBaseUrl: string | undefined,
  ) {}

  async renditions(originalIds: (string | null | undefined)[]): Promise<Map<string, Rendition[]>> {
    const ids = [...new Set(originalIds.filter((x): x is string => !!x))];
    const map = new Map<string, Rendition[]>();
    if (!ids.length) return map;
    const { results } = await this.db
      .prepare(
        `SELECT parent_asset_id, object_key, width FROM media_assets
          WHERE parent_asset_id IN (SELECT value FROM json_each(?1)) AND status = 'ACTIVE' AND bucket = 'PUBLIC' AND width IS NOT NULL
          ORDER BY width`,
      )
      .bind(JSON.stringify(ids))
      .all<{ parent_asset_id: string; object_key: string; width: number }>();
    for (const r of results) map.set(r.parent_asset_id, [...(map.get(r.parent_asset_id) ?? []), { key: r.object_key, width: r.width }]);
    return map;
  }

  /** Alt text per image in `lang` (falls back to the default language), for images whose owner has no alt of its own. */
  async altTexts(assetIds: (string | null | undefined)[], lang: string): Promise<Map<string, string>> {
    const ids = [...new Set(assetIds.filter((x): x is string => !!x))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const { results } = await this.db
      .prepare(
        `SELECT media_asset_id, language_code, alt_text FROM media_asset_translations
          WHERE media_asset_id IN (SELECT value FROM json_each(?1)) AND alt_text IS NOT NULL AND trim(alt_text) <> ''`,
      )
      .bind(JSON.stringify(ids))
      .all<{ media_asset_id: string; language_code: string; alt_text: string }>();
    const byAsset = new Map<string, Record<string, string>>();
    for (const r of results) byAsset.set(r.media_asset_id, { ...byAsset.get(r.media_asset_id), [r.language_code]: r.alt_text });
    for (const [id, texts] of byAsset) {
      const text = texts[lang] ?? texts[DEFAULT_LOCALE_CODE];
      if (text) out.set(id, text);
    }
    return out;
  }

  /** "url 480w, url 960w, original 2400w" — null when the image has no renditions (plain src is enough). */
  srcset(renditions: Rendition[] | undefined, original: { key: string | null | undefined; width: number | null | undefined }): string | null {
    if (!renditions?.length || !original.key || !original.width) return null;
    const parts = [...renditions.filter((r) => r.width < original.width!), { key: original.key, width: original.width }]
      .map((r) => {
        const url = publicMediaUrl(r.key, this.mediaBaseUrl);
        return url ? `${url} ${r.width}w` : null;
      })
      .filter((x): x is string => !!x);
    return parts.length > 1 ? parts.join(", ") : null;
  }
}
