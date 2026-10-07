/**
 * Global search (spec §40–41, Phase 13). The index is only for matching words; everything a
 * result shows (visibility, image, price, availability) is read from the source tables.
 */
import type { LocaleCode } from "./i18n/locales.ts";

export const SEARCH_ENTITY_TYPES = [
  "HOUSE", "VIP_TENT", "CAMPING", "FOOD", "ACTIVITY", "PROMOTION", "FAQ", "HISTORY", "GALLERY", "ARTICLE",
] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const SEARCH_LIMITS = {
  maxQueryLength: 100,
  maxTokens: 6,
  maxResults: 24,
} as const;

/**
 * Text used for matching: Unicode-normalised, lower case, no zero-width characters, single spaces.
 * Thai has no spaces between words, so matching is by substring.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

export function searchTokens(query: string): string[] {
  return [...new Set(normalizeSearchText(query).split(" ").filter(Boolean))].slice(0, SEARCH_LIMITS.maxTokens);
}

export interface SearchResultDto {
  type: SearchEntityType;
  id: string;
  title: string;
  summary: string | null;
  /** In-site path in the requested language. */
  url: string;
  image: { url: string; srcset: string | null; alt: string; width: number | null; height: number | null } | null;
  /** Starting price, when the result is something you can book or order. */
  price: { satang: number; per: "NIGHT" | "ADULT_NIGHT" | "PERSON" | "SET" | "ITEM" } | null;
  /** Only with dates: checked live against bookings and capacity (never from the index). */
  availability: { available: boolean; remaining: number | null } | null;
}

/** GET /api/search */
export interface SearchResponseDto {
  query: string;
  lang: LocaleCode;
  checkIn: string | null;
  checkOut: string | null;
  results: SearchResultDto[];
}

/** GET /api/admin/search/analytics */
export interface SearchAnalyticsDto {
  days: number;
  index: { rows: number; rebuiltAt: string | null };
  top: { query: string; language: LocaleCode; searches: number; zeroResults: number; clicks: number }[];
  zeroResults: { query: string; language: LocaleCode; searches: number }[];
}
