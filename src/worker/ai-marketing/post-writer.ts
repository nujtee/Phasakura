import { POST_TEXT_MAX, POST_UTM_SOURCE, type PostChannel } from "../../shared/ai-post-types.ts";
import { addDays } from "../../shared/dates.ts";
import { getLocale, type LocaleCode } from "../../shared/i18n/locales.ts";
import { pagePath } from "../../shared/routes.ts";

/**
 * Module C prompts: a post / LINE message that sells quiet dates. The AI gets public facts only (units, prices,
 * dates still free, the owner's own offer) — never booking or guest data — and must leave {LINK} where the link goes;
 * the Worker puts in the tracked booking link itself.
 */
export interface PostFacts {
  siteName: string | null;
  area: string | null;
  dates: { from: string; to: string; nights: number; freeUnits: number | null } | null;
  units: { name: string; type: "HOUSE" | "VIP_TENT"; maxGuests: number; priceBaht: number; shortDescription: string | null }[];
  offer: string | null;
  note: string | null;
}

const LANGUAGE: Record<string, string> = { th: "Thai (ภาษาไทย)", en: "English", "zh-CN": "Simplified Chinese (简体中文)" };

const CHANNEL_RULES: Record<PostChannel, string> = {
  FACEBOOK: "A Facebook page post: 60–150 words, a strong first line, short paragraphs, 3–5 relevant hashtags at the end.",
  INSTAGRAM: "An Instagram caption: a hook in the first line, 40–120 words, line breaks, then 6–10 relevant hashtags on the last line.",
  LINE: "A LINE Official Account message to friends of the account: friendly and short (under 400 characters), 1–2 emoji at most, no hashtags.",
};

export function postSystemPrompt(channel: PostChannel, lang: LocaleCode): string {
  return `You write marketing posts for a small Thai holiday stay (houses, VIP tents, camping).
Write 3 different versions in ${LANGUAGE[lang] ?? lang}. ${CHANNEL_RULES[channel]}
Rules:
- Use only the facts given. Never invent discounts, prices, events, awards, reviews or amenities. Mention an offer only if "offer" is given, word for word in meaning.
- If dates are given, say which nights are still available in a natural way; do not claim rooms are almost sold out.
- Put the placeholder {LINK} exactly once where the booking link should go. Do not write any other URL, phone number or e-mail.
- No guest names, no personal data.
Answer with JSON only: {"variants":[{"text":"…"},{"text":"…"},{"text":"…"}]}`;
}

export function postUserPrompt(facts: PostFacts): string {
  return `Facts (JSON):\n${JSON.stringify(facts)}\n\nAnswer with the JSON only.`;
}

/** Booking link with UTM tags: the dates' first night (one night, changeable on the page) and the featured unit. */
export function trackedLink(base: string, lang: LocaleCode, channel: PostChannel, opts: { from?: string | null; unitSlug?: string | null; today: string }): string {
  const url = new URL(pagePath(getLocale(lang), "booking"), base);
  if (opts.from) {
    url.searchParams.set("checkIn", opts.from);
    url.searchParams.set("checkOut", addDays(opts.from, 1));
    if (opts.unitSlug) url.searchParams.set("unit", opts.unitSlug);
  }
  url.searchParams.set("utm_source", POST_UTM_SOURCE[channel]);
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", `ai_post_${(opts.from ?? opts.today).replaceAll("-", "")}`);
  return url.toString();
}

const URLISH = /\b(?:https?:\/\/|www\.)\S+/gi;

/** The AI's answer → up to 3 variants with the link put in (other URLs taken out), or null when unusable. */
export function parsePostDraft(answer: string, link: string): { text: string }[] | null {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { variants?: unknown }).variants) ? (raw as { variants: unknown[] }).variants : [];
  const out = list
    .map((v) => (typeof v === "object" && v !== null ? (v as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => {
      const s = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").replace(URLISH, "").replace(/\n{3,}/g, "\n\n").trim();
      const first = s.indexOf("{LINK}");
      let before = first < 0 ? `${s}\n\n` : s.slice(0, first);
      let after = first < 0 ? "" : s.slice(first + 6).replaceAll("{LINK}", "");
      // Never cut the link: shorten the text after it, then before it.
      const room = POST_TEXT_MAX - link.length;
      if (before.length + after.length > room) after = after.slice(0, Math.max(0, room - before.length));
      if (before.length > room) before = before.slice(0, room);
      return { text: `${before}${link}${after}`.trim() };
    })
    .slice(0, 3);
  return out.length ? out : null;
}
