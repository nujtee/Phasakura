/**
 * Page metadata (spec §42, Phase 13): one structure rendered into the HTML <head> by the Worker
 * for crawlers and first paint, and applied by the client on in-app navigation.
 */
import type { LocaleCode } from "./i18n/locales.ts";

/** hreflang value per site language. Simplified Chinese uses the script subtag (CN, SG, MY readers alike). */
export const HREFLANG: Record<LocaleCode, string> = { th: "th", en: "en", "zh-CN": "zh-Hans" };

/** Open Graph locale per site language. */
export const OG_LOCALE: Record<LocaleCode, string> = { th: "th_TH", en: "en_US", "zh-CN": "zh_CN" };

export type RobotsDirective = "index,follow" | "noindex,follow" | "index,nofollow" | "noindex,nofollow";

export interface MetaImageDto {
  url: string;
  width: number | null;
  height: number | null;
  alt: string;
}

export interface PageMetaDto {
  /** The path this metadata belongs to (the client ignores answers for a page it already left). */
  path: string;
  /** 404 for unknown pages / accommodation slugs (served with the app shell, never indexed). */
  status: 200 | 404;
  lang: LocaleCode;
  title: string;
  description: string | null;
  /** Absolute https URL, or null when the page must not be indexed. */
  canonical: string | null;
  robots: RobotsDirective;
  /** hreflang alternates incl. x-default; empty for pages that are not indexed. */
  alternates: { hreflang: string; href: string }[];
  og: {
    type: "website";
    title: string;
    description: string | null;
    url: string | null;
    siteName: string | null;
    locale: string;
    localeAlternates: string[];
    image: MetaImageDto | null;
  };
  /** schema.org objects, each rendered as its own application/ld+json block. */
  jsonLd: Record<string, unknown>[];
  /** Google Search Console HTML-tag verification code (Marketing settings). */
  googleSiteVerification: string | null;
  /** Branding favicon, so the very first paint already has it. */
  favicon: string | null;
}

/** Content groups in the translation coverage report (Phase 13). */
export const TRANSLATION_KINDS = [
  "accommodation", "amenity", "foodCategory", "foodOption", "homeSlide", "homeSection", "galleryCategory", "galleryImage",
  "historySection", "historyTimeline", "settings", "seo",
] as const;
export type TranslationKind = (typeof TRANSLATION_KINDS)[number];

/** GET /api/admin/i18n/coverage — visible content whose Thai text has no EN / ZH-CN version yet. */
export interface TranslationCoverageDto {
  kinds: {
    kind: TranslationKind;
    /** Visible records that have Thai text. */
    total: number;
    missing: { en: number; "zh-CN": number };
    /** First 20 records missing at least one language. */
    items: { id: string; label: string; missing: ("en" | "zh-CN")[] }[];
  }[];
}
