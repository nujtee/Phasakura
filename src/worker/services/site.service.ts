import type { MediaRef, PublicSiteDto } from "../../shared/api-types.ts";
import {
  DEFAULT_LOCALE_CODE,
  LOCALE_CODES,
  parseLocale,
  type Locale,
  type LocaleCode,
} from "../../shared/i18n/locales.ts";
import { CTA_ICONS, CTA_PAGES, type BookingCtaDto, type CtaPage, type PublicSiteExtrasDto } from "../../shared/settings-types.ts";
import { validateThemeTokens, type ThemeTokens } from "../../shared/theme.ts";
import type { CtaRecord, SiteSettingsRepository, SiteTranslationRecord } from "../repositories/site-settings.repository.ts";
import { publicMediaUrl } from "./media-url.ts";
import { addFriendUrl } from "../../shared/line-types.ts";
import { customFontFamily, FONT_TOKENS } from "../../shared/theme.ts";
import type { PublicFontFaceDto } from "../../shared/media-types.ts";

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
    const fallback = pickTranslation(record?.translations ?? [], defaultLanguage);

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

    const labels = record?.ctaLabels ?? [];
    const label = labels.find((l) => parseLocale(l.language_code)?.code === locale.code)?.label
      ?? labels.find((l) => parseLocale(l.language_code)?.code === defaultLanguage)?.label
      ?? null;

    const theme = parseTheme(record?.themeTokensJson);
    return {
      configured: record !== null,
      language: locale.code,
      defaultLanguage,
      languages: [...LOCALE_CODES],
      siteName,
      tagline: nonEmpty(translation?.tagline),
      logo: { main, mobile },
      theme,
      favicon: publicMediaUrl(branding?.faviconKey, this.publicMediaBaseUrl) ?? null,
      loginLogo: publicMediaUrl(branding?.loginLogoKey, this.publicMediaBaseUrl) ?? null,
      contact: {
        phone: nonEmpty(record?.contact?.phone),
        email: nonEmpty(record?.contact?.email),
        lineOaUrl: nonEmpty(record?.contact?.lineOaUrl),
        mapUrl: nonEmpty(record?.contact?.mapUrl),
        address: nonEmpty(translation?.address) ?? nonEmpty(fallback?.address),
      },
      footerText: nonEmpty(translation?.footerText) ?? nonEmpty(fallback?.footerText),
      bookingCta: toCta(record?.cta ?? null, nonEmpty(label)),
      fonts: fontFaces(theme, record?.fonts ?? [], this.publicMediaBaseUrl),
      lineButton: record?.lineButton?.enabled
        ? (() => {
            const url = nonEmpty(record.contact?.lineOaUrl) ?? addFriendUrl(record.lineButton.basicId);
            return url ? { url } : null;
          })()
        : null,
    };
  }
}

/** Stored tokens are re-validated on the way out: an invalid theme is dropped, never half-applied. */
export function parseTheme(json: string | null | undefined): ThemeTokens | null {
  if (!json) return null;
  try {
    const tokens = JSON.parse(json) as unknown;
    // Uploaded families were checked against the font library when the theme was saved.
    return Object.keys(validateThemeTokens(tokens, "any")).length === 0 ? (tokens as ThemeTokens) : null;
  } catch {
    return null;
  }
}

export function ctaPages(json: string): CtaPage[] {
  try {
    const pages = JSON.parse(json) as unknown;
    if (Array.isArray(pages)) return pages.filter((p): p is CtaPage => (CTA_PAGES as readonly unknown[]).includes(p));
  } catch {
    // fall through
  }
  return ["*"];
}

function toCta(row: CtaRecord | null, label: string | null): PublicSiteExtrasDto["bookingCta"] {
  if (!row || row.enabled !== 1) return null;
  return {
    enabled: true,
    showOnDesktop: row.show_on_desktop === 1,
    showOnMobile: row.show_on_mobile === 1,
    desktopPosition: row.desktop_position as BookingCtaDto["desktopPosition"],
    mobilePosition: row.mobile_position as BookingCtaDto["mobilePosition"],
    size: row.size as BookingCtaDto["size"],
    icon: (CTA_ICONS as readonly string[]).includes(row.icon) ? (row.icon as BookingCtaDto["icon"]) : "calendar",
    color: row.color && /^#[0-9A-Fa-f]{6}$/.test(row.color) ? row.color : null,
    animation: row.animation as BookingCtaDto["animation"],
    closeable: row.closeable === 1,
    pages: ctaPages(row.pages_json),
    label,
  };
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

/** Faces of the uploaded families the published theme uses (others are never downloaded by visitors). */
export function fontFaces(
  theme: ThemeTokens | null,
  fonts: { family: string; weight: number; style: string; object_key: string; mime_type: string }[],
  baseUrl: string | undefined,
): PublicFontFaceDto[] {
  if (!theme) return [];
  const used = new Set(FONT_TOKENS.map((t) => (theme[t] ? customFontFamily(theme[t]!) : null)).filter((f): f is string => !!f));
  return fonts.flatMap((f) => {
    const url = used.has(f.family) ? publicMediaUrl(f.object_key, baseUrl) : null;
    return url ? [{
      family: f.family, url, weight: f.weight, style: f.style === "italic" ? "italic" as const : "normal" as const,
      format: f.mime_type === "font/woff" ? "woff" as const : "woff2" as const,
    }] : [];
  });
}
