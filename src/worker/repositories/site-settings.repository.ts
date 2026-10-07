import type { D1DatabaseLike } from "../env.ts";

/**
 * Site settings as stored in D1 (migrations 0002 + 0003):
 *   site_settings               (id = 1 singleton, default_language, …)
 *   site_setting_translations   (language_code PK, site_name, tagline, …)
 *   branding_settings           (id = 1, logo_main_asset_id, logo_mobile_asset_id, …) → media_assets
 * Only PUBLIC + ACTIVE media assets are ever exposed as logos.
 */
export interface SiteTranslationRecord {
  languageCode: string;
  siteName: string | null;
  tagline: string | null;
}

export interface BrandingRecord {
  logoMainKey: string | null;
  logoMainWidth: number | null;
  logoMainHeight: number | null;
  logoMobileKey: string | null;
  logoMobileWidth: number | null;
  logoMobileHeight: number | null;
}

export interface SiteSettingsRecord {
  defaultLanguage: string | null;
  translations: SiteTranslationRecord[];
  branding: BrandingRecord | null;
}

export interface SiteSettingsRepository {
  /** Returns null when the site has not been set up yet (no schema or no row). */
  findPublicSettings(): Promise<SiteSettingsRecord | null>;
}

interface SettingsRow {
  default_language: string | null;
}
interface TranslationRow {
  language_code: string;
  site_name: string | null;
  tagline: string | null;
}
interface BrandingRow {
  logo_main_key: string | null;
  logo_main_width: number | null;
  logo_main_height: number | null;
  logo_mobile_key: string | null;
  logo_mobile_width: number | null;
  logo_mobile_height: number | null;
}

export function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

export class D1SiteSettingsRepository implements SiteSettingsRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async findPublicSettings(): Promise<SiteSettingsRecord | null> {
    let results;
    try {
      // One round trip. Every statement is static SQL — no user input is interpolated.
      results = await this.db.batch([
        this.db.prepare("SELECT default_language FROM site_settings WHERE id = 1"),
        this.db.prepare(
          "SELECT language_code, site_name, tagline FROM site_setting_translations",
        ),
        this.db.prepare(
          `SELECT lm.object_key AS logo_main_key, lm.width AS logo_main_width, lm.height AS logo_main_height,
                  mm.object_key AS logo_mobile_key, mm.width AS logo_mobile_width, mm.height AS logo_mobile_height
             FROM branding_settings b
             LEFT JOIN media_assets lm
               ON lm.id = b.logo_main_asset_id AND lm.bucket = 'PUBLIC' AND lm.status = 'ACTIVE'
             LEFT JOIN media_assets mm
               ON mm.id = b.logo_mobile_asset_id AND mm.bucket = 'PUBLIC' AND mm.status = 'ACTIVE'
            WHERE b.id = 1`,
        ),
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
        }
      : null;

    return { defaultLanguage: settings.default_language, translations, branding };
  }
}
