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

    return {
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
