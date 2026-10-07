/**
 * API contract types shared by the Worker and the React client.
 */
import type { LocaleCode } from "./i18n/locales.ts";

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
  /** false until an administrator has saved website settings (Phase 9). */
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
}

/** GET /api/health */
export interface HealthDto {
  status: "ok" | "degraded";
  database: "ok" | "unavailable";
  time: string;
}
