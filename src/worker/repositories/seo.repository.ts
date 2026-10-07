import type { D1DatabaseLike } from "../env.ts";

export interface SeoRow {
  language_code: string;
  seo_title: string | null;
  meta_description: string | null;
  canonical_url: string | null;
  og_title: string | null;
  og_description: string | null;
  robots: string;
  schema_json: string | null;
  og_key: string | null;
  og_width: number | null;
  og_height: number | null;
}

export interface SitemapDates {
  home: string | null;
  gallery: string | null;
  booking: string | null;
  history: string | null;
}

/**
 * Read-only queries behind page metadata, sitemap and redirects (Phase 13). Static SQL only;
 * which content is public is decided by the content services, never re-implemented here.
 */
export class SeoRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Admin SEO texts of one page, every language (OG image: active public original only). */
  async page(pageKey: string): Promise<SeoRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.language_code, s.seo_title, s.meta_description, s.canonical_url, s.og_title, s.og_description, s.robots,
                s.schema_json, m.object_key AS og_key, m.width AS og_width, m.height AS og_height
           FROM seo_settings s
           LEFT JOIN media_assets m ON m.id = s.og_image_asset_id AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE'
                                   AND m.parent_asset_id IS NULL
          WHERE s.page_key = ?1`,
      )
      .bind(pageKey)
      .all<SeoRow>();
    return results;
  }

  /** robots + canonical per page × language (the sitemap leaves out noindex pages and pages canonical elsewhere). */
  async robots(): Promise<{ page_key: string; language_code: string; robots: string; canonical_url: string | null }[]> {
    const { results } = await this.db
      .prepare("SELECT page_key, language_code, robots, canonical_url FROM seo_settings")
      .all<{ page_key: string; language_code: string; robots: string; canonical_url: string | null }>();
    return results;
  }

  async extras(): Promise<{ gsc: string | null; latitude: number | null; longitude: number | null }> {
    const [m, s] = await this.db.batch([
      this.db.prepare("SELECT gsc_verification FROM marketing_settings WHERE id = 1"),
      this.db.prepare("SELECT latitude, longitude FROM site_settings WHERE id = 1"),
    ]);
    const marketing = (m?.results[0] ?? null) as { gsc_verification: string | null } | null;
    const site = (s?.results[0] ?? null) as { latitude: number | null; longitude: number | null } | null;
    return { gsc: marketing?.gsc_verification ?? null, latitude: site?.latitude ?? null, longitude: site?.longitude ?? null };
  }

  /** Last change of what each page shows (sitemap <lastmod>). */
  async pageDates(): Promise<SitemapDates> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT max(d) FROM (SELECT max(updated_at) AS d FROM home_slides WHERE status = 'PUBLISHED'
                                UNION ALL SELECT max(updated_at) FROM home_sections WHERE status = 'PUBLISHED'
                                UNION ALL SELECT updated_at FROM site_settings WHERE id = 1)) AS home,
           (SELECT max(d) FROM (SELECT max(updated_at) AS d FROM gallery_images WHERE status = 'PUBLISHED'
                                UNION ALL SELECT max(updated_at) FROM gallery_categories WHERE status = 'PUBLISHED')) AS gallery,
           (SELECT max(d) FROM (SELECT max(updated_at) AS d FROM accommodation_units WHERE status = 'ACTIVE'
                                UNION ALL SELECT updated_at FROM camping_settings WHERE id = 1)) AS booking,
           (SELECT max(d) FROM (SELECT max(updated_at) AS d FROM history_sections WHERE status = 'PUBLISHED'
                                UNION ALL SELECT max(updated_at) FROM history_timeline WHERE status = 'PUBLISHED')) AS history`,
      )
      .first<SitemapDates>();
    return row ?? { home: null, gallery: null, booking: null, history: null };
  }

  /** Last change per active unit (sitemap). */
  async unitDates(): Promise<Map<string, string>> {
    const { results } = await this.db
      .prepare("SELECT slug, updated_at FROM accommodation_units WHERE status = 'ACTIVE'")
      .all<{ slug: string; updated_at: string }>();
    return new Map(results.map((r) => [r.slug, r.updated_at]));
  }

  async seoDates(): Promise<Map<string, string>> {
    const { results } = await this.db
      .prepare("SELECT page_key, max(updated_at) AS updated_at FROM seo_settings GROUP BY page_key")
      .all<{ page_key: string; updated_at: string }>();
    return new Map(results.map((r) => [r.page_key, r.updated_at]));
  }

  /** Active redirect for an exact path (Website → SEO → Redirects). */
  async redirect(path: string): Promise<{ id: string; to_path: string; status_code: number } | null> {
    return this.db
      .prepare("SELECT id, to_path, status_code FROM seo_redirects WHERE from_path = ?1 AND is_active = 1")
      .bind(path)
      .first<{ id: string; to_path: string; status_code: number }>();
  }

  async countRedirectHit(id: string): Promise<void> {
    await this.db.prepare("UPDATE seo_redirects SET hit_count = hit_count + 1 WHERE id = ?1").bind(id).run();
  }
}
