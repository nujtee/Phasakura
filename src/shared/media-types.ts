import type { FontStackKey } from "./theme.ts";

/**
 * Image handling profiles (Phase 12). The admin's browser re-encodes a photo before upload
 * (WebP, metadata removed, orientation applied) to at most `maxWidth`, and adds smaller
 * renditions at `widths` for responsive `srcset`. Logos, favicons and payment QR codes are
 * stored exactly as uploaded (sharp edges, transparency, scannability).
 */
export type ImageProfilePurpose =
  | "LOGO" | "FAVICON" | "HOME_SLIDE" | "HOME_SECTION" | "GALLERY" | "HISTORY" | "ACCOMMODATION" | "FOOD" | "OG_IMAGE" | "PAYMENT_QR";

export interface ImageProfile {
  /** false = upload the original bytes unchanged. */
  compress: boolean;
  maxWidth: number;
  /** Responsive renditions (only those smaller than the final image are made). */
  widths: readonly number[];
  /** Preferred output; falls back to JPEG where the browser cannot encode WebP. */
  format: "image/webp" | "image/jpeg";
  quality: number;
}

export const IMAGE_PROFILES: Record<ImageProfilePurpose, ImageProfile> = {
  HOME_SLIDE: { compress: true, maxWidth: 2400, widths: [640, 1024, 1600], format: "image/webp", quality: 0.82 },
  GALLERY: { compress: true, maxWidth: 2400, widths: [480, 960, 1600], format: "image/webp", quality: 0.82 },
  ACCOMMODATION: { compress: true, maxWidth: 2000, widths: [480, 960, 1440], format: "image/webp", quality: 0.82 },
  HISTORY: { compress: true, maxWidth: 2000, widths: [480, 960, 1440], format: "image/webp", quality: 0.82 },
  HOME_SECTION: { compress: true, maxWidth: 2000, widths: [480, 960, 1440], format: "image/webp", quality: 0.82 },
  FOOD: { compress: true, maxWidth: 1600, widths: [400, 800], format: "image/webp", quality: 0.82 },
  // Social cards: crawlers handle JPEG everywhere; 1200 px is what they display.
  OG_IMAGE: { compress: true, maxWidth: 1200, widths: [], format: "image/jpeg", quality: 0.86 },
  LOGO: { compress: false, maxWidth: 0, widths: [], format: "image/webp", quality: 1 },
  FAVICON: { compress: false, maxWidth: 0, widths: [], format: "image/webp", quality: 1 },
  PAYMENT_QR: { compress: false, maxWidth: 0, widths: [], format: "image/webp", quality: 1 },
};

/** Server limits for renditions sent with an upload. */
export const MAX_VARIANTS = 5;

/** `sizes` hints for the public pages (how wide an image is drawn). */
export const IMAGE_SIZES = {
  hero: "100vw",
  card: "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
  gallery: "(min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw",
  galleryWide: "(min-width: 1024px) 50vw, 100vw",
  lightbox: "100vw",
  half: "(min-width: 768px) 50vw, 100vw",
  thumb: "160px",
} as const;

export const FONT_STYLES = ["normal", "italic"] as const;
export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
export const FONT_FALLBACKS = ["SANS", "ROUNDED", "SERIF", "MONO"] as const satisfies readonly FontStackKey[];
export const MAX_FONT_BYTES = 2 * 1024 * 1024;

export interface CustomFontDto {
  id: string;
  family: string;
  weight: number;
  style: (typeof FONT_STYLES)[number];
  fallback: FontStackKey;
  url: string;
  format: "woff2" | "woff";
  sizeBytes: number;
  /** Token value to use in the theme for this family. */
  token: string;
  createdAt: string;
}

/** A font face the public site loads (only families the published theme uses). */
export interface PublicFontFaceDto {
  family: string;
  url: string;
  weight: number;
  style: "normal" | "italic";
  format: "woff2" | "woff";
}
