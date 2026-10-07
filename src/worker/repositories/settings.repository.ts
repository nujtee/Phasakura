import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

/**
 * Admin reads / writes of singleton settings (site, branding, booking CTA, marketing),
 * per-page SEO, and theme versions. Singletons are UPSERTed so a fresh production
 * database (no dev seed) works on the first save.
 */
export class SettingsRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  // ================================================================ website

  site() {
    return this.db
      .prepare(
        `SELECT default_language, timezone, currency, contact_phone, contact_email, line_oa_url, map_url, latitude, longitude, updated_at
           FROM site_settings WHERE id = 1`,
      )
      .first<{
        default_language: string; timezone: string; currency: string; contact_phone: string | null; contact_email: string | null;
        line_oa_url: string | null; map_url: string | null; latitude: number | null; longitude: number | null; updated_at: string;
      }>();
  }

  async siteTexts() {
    const { results } = await this.db
      .prepare("SELECT language_code, site_name, tagline, address, footer_text FROM site_setting_translations")
      .all<{ language_code: string; site_name: string | null; tagline: string | null; address: string | null; footer_text: string | null }>();
    return results;
  }

  saveSiteStatement(s: {
    contactPhone: string | null; contactEmail: string | null; lineOaUrl: string | null; mapUrl: string | null;
    latitude: number | null; longitude: number | null;
  }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO site_settings (id, default_language, contact_phone, contact_email, line_oa_url, map_url, latitude, longitude, updated_at, updated_by)
         VALUES (1, 'th', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET contact_phone = excluded.contact_phone, contact_email = excluded.contact_email,
           line_oa_url = excluded.line_oa_url, map_url = excluded.map_url, latitude = excluded.latitude,
           longitude = excluded.longitude, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(s.contactPhone, s.contactEmail, s.lineOaUrl, s.mapUrl, s.latitude, s.longitude, now, actorId);
  }

  saveSiteTextStatement(lang: string, t: { siteName: string | null; tagline: string | null; address: string | null; footerText: string | null } | null): D1PreparedStatementLike {
    if (!t) return this.db.prepare("DELETE FROM site_setting_translations WHERE language_code = ?1").bind(lang);
    return this.db
      .prepare(
        `INSERT INTO site_setting_translations (language_code, site_name, tagline, address, footer_text) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (language_code) DO UPDATE SET site_name = excluded.site_name, tagline = excluded.tagline,
           address = excluded.address, footer_text = excluded.footer_text`,
      )
      .bind(lang, t.siteName, t.tagline, t.address, t.footerText);
  }

  // ================================================================ branding

  branding() {
    return this.db
      .prepare(
        `SELECT b.logo_main_asset_id, b.logo_mobile_asset_id, b.favicon_asset_id, b.login_logo_asset_id, b.updated_at,
                a1.object_key AS k1, a1.width AS w1, a1.height AS h1, a2.object_key AS k2, a2.width AS w2, a2.height AS h2,
                a3.object_key AS k3, a3.width AS w3, a3.height AS h3, a4.object_key AS k4, a4.width AS w4, a4.height AS h4
           FROM branding_settings b
           LEFT JOIN media_assets a1 ON a1.id = b.logo_main_asset_id AND a1.status = 'ACTIVE' AND a1.bucket = 'PUBLIC'
           LEFT JOIN media_assets a2 ON a2.id = b.logo_mobile_asset_id AND a2.status = 'ACTIVE' AND a2.bucket = 'PUBLIC'
           LEFT JOIN media_assets a3 ON a3.id = b.favicon_asset_id AND a3.status = 'ACTIVE' AND a3.bucket = 'PUBLIC'
           LEFT JOIN media_assets a4 ON a4.id = b.login_logo_asset_id AND a4.status = 'ACTIVE' AND a4.bucket = 'PUBLIC'
          WHERE b.id = 1`,
      )
      .first<Record<string, string | number | null>>();
  }

  saveBrandingStatement(ids: { logoMain: string | null; logoMobile: string | null; favicon: string | null; loginLogo: string | null }, actorId: string, now: string) {
    return this.db
      .prepare(
        `INSERT INTO branding_settings (id, logo_main_asset_id, logo_mobile_asset_id, favicon_asset_id, login_logo_asset_id, updated_at, updated_by)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET logo_main_asset_id = excluded.logo_main_asset_id, logo_mobile_asset_id = excluded.logo_mobile_asset_id,
           favicon_asset_id = excluded.favicon_asset_id, login_logo_asset_id = excluded.login_logo_asset_id,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(ids.logoMain, ids.logoMobile, ids.favicon, ids.loginLogo, now, actorId);
  }

  asset(id: string) {
    return this.db.prepare("SELECT id, purpose, bucket, status, parent_asset_id FROM media_assets WHERE id = ?1").bind(id)
      .first<{ id: string; purpose: string; bucket: string; status: string; parent_asset_id: string | null }>();
  }

  // ================================================================ booking CTA

  cta() {
    return this.db
      .prepare(
        `SELECT enabled, show_on_desktop, show_on_mobile, desktop_position, mobile_position, size, icon, color, animation,
                closeable, pages_json FROM booking_cta_settings WHERE id = 1`,
      )
      .first<{
        enabled: number; show_on_desktop: number; show_on_mobile: number; desktop_position: string; mobile_position: string;
        size: string; icon: string; color: string | null; animation: string; closeable: number; pages_json: string;
      }>();
  }

  async ctaLabels() {
    const { results } = await this.db.prepare("SELECT language_code, label FROM booking_cta_translations").all<{ language_code: string; label: string }>();
    return results;
  }

  saveCtaStatement(c: {
    enabled: boolean; showOnDesktop: boolean; showOnMobile: boolean; desktopPosition: string; mobilePosition: string; size: string;
    icon: string; color: string | null; animation: string; closeable: boolean; pages: string[];
  }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_cta_settings (id, enabled, show_on_desktop, show_on_mobile, desktop_position, mobile_position, size, icon,
                                           color, animation, closeable, pages_json, updated_at, updated_by)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, show_on_desktop = excluded.show_on_desktop,
           show_on_mobile = excluded.show_on_mobile, desktop_position = excluded.desktop_position,
           mobile_position = excluded.mobile_position, size = excluded.size, icon = excluded.icon, color = excluded.color,
           animation = excluded.animation, closeable = excluded.closeable, pages_json = excluded.pages_json,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(c.enabled ? 1 : 0, c.showOnDesktop ? 1 : 0, c.showOnMobile ? 1 : 0, c.desktopPosition, c.mobilePosition, c.size,
        c.icon, c.color, c.animation, c.closeable ? 1 : 0, JSON.stringify(c.pages), now, actorId);
  }

  saveCtaLabelStatement(lang: string, label: string | null): D1PreparedStatementLike {
    if (!label) return this.db.prepare("DELETE FROM booking_cta_translations WHERE language_code = ?1").bind(lang);
    return this.db
      .prepare(`INSERT INTO booking_cta_translations (language_code, label) VALUES (?1, ?2)
                ON CONFLICT (language_code) DO UPDATE SET label = excluded.label`)
      .bind(lang, label);
  }

  // ================================================================ marketing

  marketing() {
    return this.db
      .prepare(
        `SELECT ga4_enabled, ga4_measurement_id, ga4_property_id, meta_pixel_enabled, meta_pixel_id, meta_capi_enabled, gsc_verification, updated_at
           FROM marketing_settings WHERE id = 1`,
      )
      .first<{
        ga4_enabled: number; ga4_measurement_id: string | null; ga4_property_id: string | null; meta_pixel_enabled: number; meta_pixel_id: string | null;
        meta_capi_enabled: number; gsc_verification: string | null; updated_at: string;
      }>();
  }

  /** Last GA4 Data API error for the dashboard report (no credentials in it), or null. */
  async ga4ReportError(propertyId: string): Promise<string | null> {
    try {
      const row = await this.db.prepare("SELECT error FROM analytics_report_cache WHERE cache_key = ?1").bind(`ga4:dashboard:${propertyId}`).first<{ error: string | null }>();
      return row?.error ?? null;
    } catch {
      return null;
    }
  }

  saveMarketingStatement(m: {
    ga4Enabled: boolean; ga4MeasurementId: string | null; ga4PropertyId: string | null; metaPixelEnabled: boolean; metaPixelId: string | null;
    metaCapiEnabled: boolean; gscVerification: string | null;
  }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO marketing_settings (id, ga4_enabled, ga4_measurement_id, meta_pixel_enabled, meta_pixel_id, meta_capi_enabled,
                                         gsc_verification, updated_at, updated_by, ga4_property_id)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (id) DO UPDATE SET ga4_enabled = excluded.ga4_enabled, ga4_measurement_id = excluded.ga4_measurement_id,
           meta_pixel_enabled = excluded.meta_pixel_enabled, meta_pixel_id = excluded.meta_pixel_id,
           meta_capi_enabled = excluded.meta_capi_enabled, gsc_verification = excluded.gsc_verification,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by, ga4_property_id = excluded.ga4_property_id`,
      )
      .bind(m.ga4Enabled ? 1 : 0, m.ga4MeasurementId, m.metaPixelEnabled ? 1 : 0, m.metaPixelId, m.metaCapiEnabled ? 1 : 0,
        m.gscVerification, now, actorId, m.ga4PropertyId);
  }

  // ================================================================ SEO

  async seo() {
    const { results } = await this.db
      .prepare(
        `SELECT s.page_key, s.language_code, s.seo_title, s.meta_description, s.canonical_url, s.og_title, s.og_description,
                s.og_image_asset_id, s.robots, s.schema_json, m.object_key AS og_key
           FROM seo_settings s
           LEFT JOIN media_assets m ON m.id = s.og_image_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'
          ORDER BY s.page_key, s.language_code`,
      )
      .all<{
        page_key: string; language_code: string; seo_title: string | null; meta_description: string | null; canonical_url: string | null;
        og_title: string | null; og_description: string | null; og_image_asset_id: string | null; robots: string;
        schema_json: string | null; og_key: string | null;
      }>();
    return results;
  }

  saveSeoStatement(id: string, pageKey: string, lang: string, e: {
    seoTitle: string | null; metaDescription: string | null; canonicalUrl: string | null; ogTitle: string | null;
    ogDescription: string | null; ogImageAssetId: string | null; robots: string; schemaJson: string | null;
  } | null, actorId: string, now: string): D1PreparedStatementLike {
    if (!e) return this.db.prepare("DELETE FROM seo_settings WHERE page_key = ?1 AND language_code = ?2").bind(pageKey, lang);
    return this.db
      .prepare(
        `INSERT INTO seo_settings (id, page_key, language_code, seo_title, meta_description, canonical_url, og_title, og_description,
                                   og_image_asset_id, robots, schema_json, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (page_key, language_code) DO UPDATE SET seo_title = excluded.seo_title, meta_description = excluded.meta_description,
           canonical_url = excluded.canonical_url, og_title = excluded.og_title, og_description = excluded.og_description,
           og_image_asset_id = excluded.og_image_asset_id, robots = excluded.robots, schema_json = excluded.schema_json,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(id, pageKey, lang, e.seoTitle, e.metaDescription, e.canonicalUrl, e.ogTitle, e.ogDescription, e.ogImageAssetId,
        e.robots, e.schemaJson, now, actorId);
  }

  // ================================================================ theme

  async themeVersions(limit: number) {
    const { results } = await this.db
      .prepare(
        `SELECT v.id, v.version_number, v.preset, v.tokens_json, v.status, v.note, v.created_at, v.published_at,
                cu.display_name AS created_by_name, pu.display_name AS published_by_name
           FROM theme_versions v
           LEFT JOIN users cu ON cu.id = v.created_by
           LEFT JOIN users pu ON pu.id = v.published_by
          ORDER BY v.version_number DESC LIMIT ?1`,
      )
      .bind(limit)
      .all<ThemeVersionRow>();
    return results;
  }

  themeVersion(id: string) {
    return this.db
      .prepare(
        `SELECT v.id, v.version_number, v.preset, v.tokens_json, v.status, v.note, v.created_at, v.published_at,
                NULL AS created_by_name, NULL AS published_by_name
           FROM theme_versions v WHERE v.id = ?1`,
      )
      .bind(id)
      .first<ThemeVersionRow>();
  }

  themeSettings() {
    return this.db.prepare("SELECT published_version_id, draft_version_id FROM theme_settings WHERE id = 1")
      .first<{ published_version_id: string | null; draft_version_id: string | null }>();
  }

  insertThemeDraftStatement(id: string, preset: string, tokens: string, note: string | null, actorId: string, now: string) {
    return this.db
      .prepare(
        `INSERT INTO theme_versions (id, version_number, preset, tokens_json, status, note, created_by, created_at)
         VALUES (?1, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM theme_versions), ?2, ?3, 'DRAFT', ?4, ?5, ?6)`,
      )
      .bind(id, preset, tokens, note, actorId, now);
  }

  updateThemeDraftStatement(id: string, preset: string, tokens: string, note: string | null) {
    return this.db
      .prepare("UPDATE theme_versions SET preset = ?2, tokens_json = ?3, note = ?4 WHERE id = ?1 AND status = 'DRAFT'")
      .bind(id, preset, tokens, note);
  }

  /**
   * Pointers are derived from version statuses inside the same batch, so they always
   * match what actually happened (a lost race leaves both unchanged).
   */
  setThemePointersStatement(draftCandidate: string | null, actorId: string, now: string) {
    return this.db
      .prepare(
        `INSERT INTO theme_settings (id, published_version_id, draft_version_id, updated_at, updated_by)
         VALUES (1, (SELECT id FROM theme_versions WHERE status = 'PUBLISHED'),
                    (SELECT id FROM theme_versions WHERE id = ?1 AND status = 'DRAFT'), ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET published_version_id = excluded.published_version_id,
           draft_version_id = excluded.draft_version_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(draftCandidate, now, actorId);
  }

  /** Archives the live version — only if the version about to replace it is still in the expected status. */
  archivePublishedStatement(replacementId: string, replacementFrom: "DRAFT" | "ARCHIVED") {
    return this.db
      .prepare(
        `UPDATE theme_versions SET status = 'ARCHIVED'
          WHERE status = 'PUBLISHED' AND id <> ?1 AND EXISTS (SELECT 1 FROM theme_versions WHERE id = ?1 AND status = ?2)`,
      )
      .bind(replacementId, replacementFrom);
  }

  /** Publishes one version; only from the expected status so a double click cannot publish twice. */
  publishVersionStatement(id: string, from: "DRAFT" | "ARCHIVED", actorId: string, now: string) {
    return this.db
      .prepare("UPDATE theme_versions SET status = 'PUBLISHED', published_at = ?3, published_by = ?4 WHERE id = ?1 AND status = ?2 RETURNING id")
      .bind(id, from, now, actorId);
  }

  deleteDraftStatement(id: string) {
    return this.db.prepare("DELETE FROM theme_versions WHERE id = ?1 AND status = 'DRAFT'").bind(id);
  }
}

export interface ThemeVersionRow {
  id: string;
  version_number: number;
  preset: string;
  tokens_json: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  note: string | null;
  created_at: string;
  published_at: string | null;
  created_by_name: string | null;
  published_by_name: string | null;
}
