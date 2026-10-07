import type { D1DatabaseLike } from "../env.ts";

/**
 * Public site settings as stored in D1 (migrations 0002 + 0003):
 *   site_settings / site_setting_translations, branding_settings → media_assets,
 *   theme_settings → theme_versions (published tokens), booking_cta_settings / _translations.
 * Only PUBLIC + ACTIVE media assets are ever exposed. Every statement is static SQL.
 */
export interface SiteTranslationRecord {
  languageCode: string;
  siteName: string | null;
  tagline: string | null;
  address?: string | null;
  footerText?: string | null;
}

export interface BrandingRecord {
  logoMainKey: string | null;
  logoMainWidth: number | null;
  logoMainHeight: number | null;
  logoMobileKey: string | null;
  logoMobileWidth: number | null;
  logoMobileHeight: number | null;
  faviconKey?: string | null;
  loginLogoKey?: string | null;
}

export interface CtaRecord {
  enabled: number;
  show_on_desktop: number;
  show_on_mobile: number;
  desktop_position: string;
  mobile_position: string;
  size: string;
  icon: string;
  color: string | null;
  animation: string;
  closeable: number;
  pages_json: string;
}

export interface SiteSettingsRecord {
  defaultLanguage: string | null;
  contact?: { phone: string | null; email: string | null; lineOaUrl: string | null; mapUrl: string | null };
  translations: SiteTranslationRecord[];
  branding: BrandingRecord | null;
  themeTokensJson?: string | null;
  cta?: CtaRecord | null;
  ctaLabels?: { language_code: string; label: string }[];
  /** Floating LINE button (Phase 11). */
  lineButton?: { enabled: boolean; basicId: string | null } | null;
  /** Uploaded font faces (Phase 12); the service keeps those the published theme uses. */
  fonts?: { family: string; weight: number; style: string; object_key: string; mime_type: string }[];
  /** Tracking switches (Phase 14). */
  marketing?: { ga4_enabled: number; ga4_measurement_id: string | null; meta_pixel_enabled: number; meta_pixel_id: string | null } | null;
  /** Cookie banner settings and texts (Phase 14). */
  privacy?: {
    banner_enabled: number; consent_version: number; consent_days: number;
    texts: { language_code: string; banner_text: string | null; policy_title: string | null; policy_body_set: number }[];
  } | null;
}

export interface SiteSettingsRepository {
  /** Returns null when the site has not been set up yet (no schema or no row). */
  findPublicSettings(): Promise<SiteSettingsRecord | null>;
}

interface SettingsRow {
  default_language: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  line_oa_url?: string | null;
  map_url?: string | null;
}
interface TranslationRow {
  language_code: string;
  site_name: string | null;
  tagline: string | null;
  address?: string | null;
  footer_text?: string | null;
}
interface BrandingRow {
  logo_main_key: string | null;
  logo_main_width: number | null;
  logo_main_height: number | null;
  logo_mobile_key: string | null;
  logo_mobile_width: number | null;
  logo_mobile_height: number | null;
  favicon_key?: string | null;
  login_logo_key?: string | null;
}

export function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

const PUBLIC_ASSET = (alias: string, column: string) =>
  `LEFT JOIN media_assets ${alias} ON ${alias}.id = b.${column} AND ${alias}.bucket = 'PUBLIC' AND ${alias}.status = 'ACTIVE'`;

export class D1SiteSettingsRepository implements SiteSettingsRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async findPublicSettings(): Promise<SiteSettingsRecord | null> {
    let results;
    try {
      // One round trip. Every statement is static SQL — no user input is interpolated.
      results = await this.db.batch([
        this.db.prepare("SELECT default_language, contact_phone, contact_email, line_oa_url, map_url FROM site_settings WHERE id = 1"),
        this.db.prepare("SELECT language_code, site_name, tagline, address, footer_text FROM site_setting_translations"),
        this.db.prepare(
          `SELECT lm.object_key AS logo_main_key, lm.width AS logo_main_width, lm.height AS logo_main_height,
                  mm.object_key AS logo_mobile_key, mm.width AS logo_mobile_width, mm.height AS logo_mobile_height,
                  fv.object_key AS favicon_key, ll.object_key AS login_logo_key
             FROM branding_settings b
             ${PUBLIC_ASSET("lm", "logo_main_asset_id")}
             ${PUBLIC_ASSET("mm", "logo_mobile_asset_id")}
             ${PUBLIC_ASSET("fv", "favicon_asset_id")}
             ${PUBLIC_ASSET("ll", "login_logo_asset_id")}
            WHERE b.id = 1`,
        ),
        this.db.prepare(
          `SELECT v.tokens_json FROM theme_settings s JOIN theme_versions v ON v.id = s.published_version_id AND v.status = 'PUBLISHED'
            WHERE s.id = 1`,
        ),
        this.db.prepare(
          `SELECT enabled, show_on_desktop, show_on_mobile, desktop_position, mobile_position, size, icon, color, animation,
                  closeable, pages_json FROM booking_cta_settings WHERE id = 1`,
        ),
        this.db.prepare("SELECT language_code, label FROM booking_cta_translations"),
      ]);
    } catch (error) {
      // Before the Phase 2 migration has been applied the tables do not exist.
      if (isMissingTableError(error)) return null;
      throw error;
    }

    const settings = (results[0]?.results[0] as SettingsRow | undefined) ?? null;
    if (!settings) return null;

    const translations = ((results[1]?.results ?? []) as TranslationRow[]).map((row) => ({
      languageCode: row.language_code,
      siteName: row.site_name,
      tagline: row.tagline,
      address: row.address ?? null,
      footerText: row.footer_text ?? null,
    }));

    const brandingRow = (results[2]?.results[0] as BrandingRow | undefined) ?? null;
    const branding: BrandingRecord | null = brandingRow
      ? {
          logoMainKey: brandingRow.logo_main_key,
          logoMainWidth: brandingRow.logo_main_width,
          logoMainHeight: brandingRow.logo_main_height,
          logoMobileKey: brandingRow.logo_mobile_key,
          logoMobileWidth: brandingRow.logo_mobile_width,
          logoMobileHeight: brandingRow.logo_mobile_height,
          faviconKey: brandingRow.favicon_key ?? null,
          loginLogoKey: brandingRow.login_logo_key ?? null,
        }
      : null;

    // Separate from the batch: before migrations 0016 / 0017 the tables are missing and the rest must still load.
    let lineButton: SiteSettingsRecord["lineButton"] = null;
    try {
      const line = await this.db.prepare("SELECT public_button, bot_basic_id FROM line_settings WHERE id = 1")
        .first<{ public_button: number; bot_basic_id: string | null }>();
      lineButton = line ? { enabled: line.public_button === 1, basicId: line.bot_basic_id } : null;
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
    let fonts: SiteSettingsRecord["fonts"] = [];
    try {
      const { results } = await this.db
        .prepare(
          `SELECT f.family, f.weight, f.style, m.object_key, m.mime_type
             FROM custom_fonts f JOIN media_assets m ON m.id = f.media_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'
            ORDER BY f.family, f.weight, f.style`,
        )
        .all<{ family: string; weight: number; style: string; object_key: string; mime_type: string }>();
      fonts = results;
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }

    // Phase 14: tracking switches and the cookie banner (tables missing before migration 0019 → defaults).
    let marketing: SiteSettingsRecord["marketing"] = null;
    let privacy: SiteSettingsRecord["privacy"] = null;
    try {
      const [m, p, t] = await this.db.batch([
        this.db.prepare("SELECT ga4_enabled, ga4_measurement_id, meta_pixel_enabled, meta_pixel_id FROM marketing_settings WHERE id = 1"),
        this.db.prepare("SELECT banner_enabled, consent_version, consent_days FROM privacy_settings WHERE id = 1"),
        this.db.prepare(
          `SELECT language_code, banner_text, policy_title,
                  (policy_body IS NOT NULL AND trim(policy_body) <> '') AS policy_body_set
             FROM privacy_setting_translations`,
        ),
      ]);
      marketing = (m?.results[0] as SiteSettingsRecord["marketing"] | undefined) ?? null;
      const pr = p?.results[0] as { banner_enabled: number; consent_version: number; consent_days: number } | undefined;
      privacy = pr ? { ...pr, texts: (t?.results ?? []) as NonNullable<SiteSettingsRecord["privacy"]>["texts"] } : null;
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }

    return {
      marketing,
      privacy,
      lineButton,
      fonts,
      defaultLanguage: settings.default_language,
      contact: {
        phone: settings.contact_phone ?? null,
        email: settings.contact_email ?? null,
        lineOaUrl: settings.line_oa_url ?? null,
        mapUrl: settings.map_url ?? null,
      },
      translations,
      branding,
      themeTokensJson: (results[3]?.results[0] as { tokens_json: string } | undefined)?.tokens_json ?? null,
      cta: (results[4]?.results[0] as CtaRecord | undefined) ?? null,
      ctaLabels: (results[5]?.results ?? []) as { language_code: string; label: string }[],
    };
  }
}
