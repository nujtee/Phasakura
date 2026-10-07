/**
 * API contract types shared by the Worker and the React client.
 */
import type { LocaleCode } from "./i18n/locales.ts";
import type { PublicFontFaceDto } from "./media-types.ts";
import type { PublicSiteExtrasDto } from "./settings-types.ts";

export interface ApiSuccess<T> {
  data: T;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    /** Field → error code, for 422 validation errors. */
    details?: Record<string, string>;
  };
}

export interface MediaRef {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
}

/** GET /api/public/site */
export interface PublicSiteDto {
  /** false until an administrator has saved website settings. */
  configured: boolean;
  language: LocaleCode;
  defaultLanguage: LocaleCode;
  languages: LocaleCode[];
  siteName: string | null;
  tagline: string | null;
  logo: {
    main: MediaRef | null;
    mobile: MediaRef | null;
  };
  /** Published theme tokens, favicon, contact details and floating booking button (Phase 9). */
  theme: PublicSiteExtrasDto["theme"];
  favicon: string | null;
  loginLogo: string | null;
  contact: PublicSiteExtrasDto["contact"];
  footerText: string | null;
  bookingCta: PublicSiteExtrasDto["bookingCta"];
  /** Floating "chat with us on LINE" button (Phase 11): add-friend / OA link, or null when off. */
  lineButton: { url: string } | null;
  /** Uploaded font faces used by the published theme (Phase 12), loaded with the FontFace API. */
  fonts: PublicFontFaceDto[];
}

/** GET /api/health */
export interface HealthDto {
  status: "ok" | "degraded";
  database: "ok" | "unavailable";
  time: string;
}
