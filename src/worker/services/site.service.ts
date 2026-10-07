import type { MediaRef, PublicSiteDto } from "../../shared/api-types.ts";
import {
  DEFAULT_LOCALE_CODE,
  LOCALE_CODES,
  parseLocale,
  type Locale,
  type LocaleCode,
} from "../../shared/i18n/locales.ts";
import type { SiteSettingsRepository, SiteTranslationRecord } from "../repositories/site-settings.repository.ts";
import { publicMediaUrl } from "./media-url.ts";

export class SiteService {
  constructor(
    private readonly repository: SiteSettingsRepository,
    private readonly publicMediaBaseUrl: string | undefined,
  ) {}

  async getPublicSite(locale: Locale): Promise<PublicSiteDto> {
    const record = await this.repository.findPublicSettings();

    const defaultLanguage: LocaleCode =
      parseLocale(record?.defaultLanguage)?.code ?? DEFAULT_LOCALE_CODE;

    const translation =
      pickTranslation(record?.translations ?? [], locale.code) ??
      pickTranslation(record?.translations ?? [], defaultLanguage);

    const siteName = nonEmpty(translation?.siteName);
    const branding = record?.branding ?? null;

    const mainUrl = publicMediaUrl(branding?.logoMainKey, this.publicMediaBaseUrl);
    const mobileUrl = publicMediaUrl(branding?.logoMobileKey, this.publicMediaBaseUrl);

    const main: MediaRef | null = mainUrl
      ? {
          url: mainUrl,
          alt: siteName ?? "",
          width: branding?.logoMainWidth ?? null,
          height: branding?.logoMainHeight ?? null,
        }
      : null;

    const mobile: MediaRef | null = mobileUrl
      ? {
          url: mobileUrl,
          alt: siteName ?? "",
          width: branding?.logoMobileWidth ?? null,
          height: branding?.logoMobileHeight ?? null,
        }
      : null;

    return {
      configured: record !== null,
      language: locale.code,
      defaultLanguage,
      languages: [...LOCALE_CODES],
      siteName,
      tagline: nonEmpty(translation?.tagline),
      logo: { main, mobile },
    };
  }
}

function pickTranslation(
  translations: SiteTranslationRecord[],
  code: LocaleCode,
): SiteTranslationRecord | undefined {
  return translations.find((t) => parseLocale(t.languageCode)?.code === code);
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
