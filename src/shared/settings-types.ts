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
  /** Whether META_CAPI_ACCESS_TOKEN is set as a Cloudflare Secret. The token itself is never returned. */
  capiTokenConfigured: boolean;
  capiTestEventCodeConfigured: boolean;
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
}
