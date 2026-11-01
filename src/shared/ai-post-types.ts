import type { ForwardMetrics } from "./ai-marketing-types.ts";
import type { LocaleCode } from "./i18n/locales.ts";

/**
 * AI post helper (AI Marketing Module C): drafts of a social post / LINE OA message that sells quiet dates. Drafts
 * only — nothing is posted or sent by the system; staff copy the text they like. The booking link is built by the
 * Worker (with UTM tags, so bookings from it show up under "where bookings came from"), never by the AI.
 */
export const POST_CHANNELS = ["FACEBOOK", "INSTAGRAM", "LINE"] as const;
export type PostChannel = (typeof POST_CHANNELS)[number];

/** UTM source per channel (medium = social). */
export const POST_UTM_SOURCE: Record<PostChannel, string> = { FACEBOOK: "facebook", INSTAGRAM: "instagram", LINE: "line" };

export const POST_OFFER_MAX = 200;
export const POST_NOTE_MAX = 300;
/** A variant is at most this long (LINE allows 5,000; posts stay readable). */
export const POST_TEXT_MAX = 2200;

export interface PostDraftRequest {
  channel: PostChannel;
  lang: LocaleCode;
  /** Stay dates to sell (first and last night); both or neither. */
  from?: string;
  to?: string;
  /** One house / VIP tent to feature (optional). */
  unitId?: string;
  /** The owner's own offer, word for word (the AI never invents one). */
  offer?: string;
  /** Anything else to say (tone, an event nearby…). */
  note?: string;
}

export interface PostDraftDto {
  variants: { text: string }[];
  /** The tracked booking link put in every variant. */
  link: string;
  model: string;
}

export interface QuietDatesDto extends ForwardMetrics {
  units: { id: string; name: string; slug: string }[];
}
