import type { LocaleCode } from "./i18n/locales.ts";

/**
 * AI content helper (AI Marketing Module B): drafts of a house / VIP tent's texts in one language. A draft is only
 * returned to the admin form — nothing is saved until staff check it and press Save. Uses the same AI switch, key
 * and monthly budget as the marketing report.
 */
export const AI_DRAFT_MODES = ["WRITE", "TRANSLATE"] as const;
/** WRITE = write (or rewrite) from the facts and current texts; TRANSLATE = turn the Thai text into this language. */
export type AiDraftMode = (typeof AI_DRAFT_MODES)[number];

/** Drafts staff may ask for per day, for the whole site. */
export const AI_DRAFTS_PER_DAY = 30;

/** Same limits as the unit translation form / API. */
export const UNIT_TEXT_LIMITS = { name: 120, shortDescription: 300, description: 5000, seoTitle: 120, seoDescription: 320 } as const;

export interface UnitTextDraftDto {
  name: string;
  shortDescription: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  model: string;
}

export interface UnitTextDraftRequest {
  lang: LocaleCode;
  mode: AiDraftMode;
  /** The form's current (maybe unsaved) texts per language; saved texts are used where left out. */
  texts?: Partial<Record<LocaleCode, { name?: string; shortDescription?: string | null; description?: string | null; seoTitle?: string | null; seoDescription?: string | null }>>;
}
