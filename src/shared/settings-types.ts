/** Website settings, branding, theme, booking CTA, marketing and SEO (spec §36–39, §42–45). */
import type { LocaleCode } from "./i18n/locales.ts";
import type { ThemePreset, ThemeTokens } from "./theme.ts";

export interface SiteTextsDto {
  siteName: string | null;
  tagline: string | null;
  address: string | null;
  footerText: string | null;
}

export interface WebsiteSettingsDto {
  defaultLanguage: LocaleCode;
  timezone: string;
  currency: string;
  contactPhone: string | null;
  contactEmail: string | null;
  lineOaUrl: string | null;
  mapUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  translations: Partial<Record<LocaleCode, SiteTextsDto>>;
  updatedAt: string | null;
}

export const BRANDING_SLOTS = ["logoMain", "logoMobile", "favicon", "loginLogo"] as const;
export type BrandingSlot = (typeof BRANDING_SLOTS)[number];

export interface BrandingDto {
  slots: Record<BrandingSlot, { assetId: string | null; url: string | null; width: number | null; height: number | null }>;
  updatedAt: string | null;
}

export interface ThemeVersionDto {
  id: string;
  versionNumber: number;
  preset: ThemePreset;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  tokens: ThemeTokens;
  note: string | null;
  createdAt: string;
  publishedAt: string | null;
  createdByName: string | null;
  publishedByName: string | null;
}

export interface ThemeAdminDto {
  published: ThemeVersionDto | null;
  draft: ThemeVersionDto | null;
  history: ThemeVersionDto[];
}

export const CTA_ICONS = ["calendar", "bed", "tent", "arrow-right", "none"] as const;
export const CTA_PAGES = ["*", "home", "gallery", "booking", "history", "accommodation"] as const;
export type CtaPage = (typeof CTA_PAGES)[number];

export interface BookingCtaDto {
  enabled: boolean;
  showOnDesktop: boolean;
  showOnMobile: boolean;
  desktopPosition: "BOTTOM_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_CENTER";
  mobilePosition: "BOTTOM_BAR" | "BOTTOM_RIGHT" | "BOTTOM_LEFT";
  size: "SM" | "MD" | "LG";
  icon: (typeof CTA_ICONS)[number];
  color: string | null;
  animation: "NONE" | "PULSE" | "BOUNCE" | "SLIDE_IN";
  closeable: boolean;
  pages: CtaPage[];
  labels: Partial<Record<LocaleCode, string>>;
}

export interface MarketingDto {
  ga4Enabled: boolean;
  ga4MeasurementId: string | null;
  metaPixelEnabled: boolean;
  metaPixelId: string | null;
  metaCapiEnabled: boolean;
  gscVerification: string | null;
  /** GA4 property (numeric) for dashboard numbers via the GA4 Data API (Phase 14). */
  ga4PropertyId: string | null;
  /** Whether the GA4_SERVICE_ACCOUNT_KEY secret is set (the key itself is never returned). */
  ga4DataKeyConfigured: boolean;
  /** Last GA4 Data API error, if the latest attempt failed. */
  ga4DataError: string | null;
  /** Whether META_CAPI_ACCESS_TOKEN is set as a Cloudflare Secret. The token itself is never returned. */
  capiTokenConfigured: boolean;
  capiTestEventCodeConfigured: boolean;
  /** Where the Conversions API takes the Pixel ID from (a META_PIXEL_ID secret wins over these settings). */
  capiPixelSource: "SECRET" | "SETTINGS" | null;
  /** The META_PIXEL_ID secret differs from the Pixel ID above (browser and server would report to different pixels). */
  capiPixelMismatch: boolean;
  updatedAt: string | null;
}

/** One Conversions API delivery (admin log). No personal data. */
export interface MarketingEventDto {
  id: string;
  eventName: "Lead" | "Purchase" | "PageView";
  eventId: string;
  bookingCode: string | null;
  isTest: boolean;
  status: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  attempts: number;
  lastError: string | null;
  skipReason: string | null;
  eventTime: string;
  createdAt: string;
  sentAt: string | null;
}

/** Settings → Privacy (spec §46). */
export interface PrivacySettingsDto {
  bannerEnabled: boolean;
  consentVersion: number;
  consentDays: number;
  translations: Partial<Record<LocaleCode, { bannerText: string | null; policyTitle: string | null; policyBody: string | null }>>;
  updatedAt: string | null;
}

/** GET /api/public/privacy — the privacy policy page. */
export interface PublicPrivacyDto {
  language: LocaleCode;
  title: string | null;
  body: string | null;
  updatedAt: string | null;
}

export const SEO_PAGE_KEYS = ["home", "gallery", "booking", "history"] as const;
export type SeoPageKey = (typeof SEO_PAGE_KEYS)[number];
export const ROBOTS_VALUES = ["index,follow", "noindex,follow", "index,nofollow", "noindex,nofollow"] as const;

export interface SeoEntryDto {
  seoTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageAssetId: string | null;
  ogImageUrl?: string | null;
  robots: (typeof ROBOTS_VALUES)[number];
  schemaJson: string | null;
}

export interface SeoPageDto {
  pageKey: SeoPageKey;
  translations: Partial<Record<LocaleCode, SeoEntryDto>>;
}

/** Extra data for the public site (theme, favicon, contact, floating CTA). */
export interface PublicSiteExtrasDto {
  theme: ThemeTokens | null;
  favicon: string | null;
  loginLogo: string | null;
  contact: { phone: string | null; email: string | null; lineOaUrl: string | null; mapUrl: string | null; address: string | null };
  footerText: string | null;
  bookingCta: (Omit<BookingCtaDto, "labels"> & { label: string | null }) | null;
  /** Trackers that are switched on (null = off). Loaded only after the matching consent (Phase 14). */
  tracking: { ga4MeasurementId: string | null; metaPixelId: string | null };
  /** Cookie banner: shown only when a tracker is on. `policyPath` = the privacy page, when it has text. */
  consent: { enabled: boolean; version: number; days: number; text: string | null; policyPath: string | null };
}
