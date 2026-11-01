import { UNIT_TEXT_LIMITS, type AiDraftMode, type UnitTextDraftDto } from "../../shared/ai-content-types.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";

/**
 * Module B prompts: texts of a house / VIP tent in one language. The AI gets the unit's public facts (type, size,
 * price, amenities, the site's name and area) and its current texts — never booking or guest data. The answer is
 * JSON, checked and cut to the form's limits; staff review it before saving.
 */
export interface UnitFacts {
  unitId: string;
  type: "HOUSE" | "VIP_TENT";
  code: string;
  priceBaht: number;
  standardGuests: number;
  maxGuests: number;
  amenities: string[];
  siteName: string | null;
  area: string | null;
}

export interface UnitDraftInput {
  lang: LocaleCode;
  mode: AiDraftMode;
  facts: UnitFacts;
  texts: Partial<Record<LocaleCode, { name: string; shortDescription: string | null; description: string | null; seoTitle: string | null; seoDescription: string | null }>>;
}

const LANGUAGE: Record<string, string> = { th: "Thai (ภาษาไทย)", en: "English", "zh-CN": "Simplified Chinese (简体中文)" };

export function unitSystemPrompt(lang: LocaleCode, mode: AiDraftMode): string {
  const target = LANGUAGE[lang] ?? lang;
  const task = mode === "TRANSLATE"
    ? `Translate the Thai texts of this accommodation into ${target}. Keep the meaning and every fact; make it read naturally for travellers; do not add facts.`
    : `Write the texts of this accommodation in ${target}: warm, concrete and honest, for travellers deciding where to stay. Use only the facts given (and the current texts); never invent amenities, views, distances or prices.`;
  return `You are a copywriter for a small Thai holiday stay (houses, VIP tents, camping).
${task}
Also write a search-engine title and description in ${target}.
Limits (characters): name ≤ 60, shortDescription ≤ 200, description 400–1500 in 2–4 short paragraphs separated by a blank line, seoTitle ≤ 60 (include the site name when given), seoDescription 120–160.
Plain text only: no markdown, no emoji, no prices unless given, no contact details, no guest names.
Answer with JSON only:
{"name":"…","shortDescription":"…","description":"…","seoTitle":"…","seoDescription":"…"}`;
}

export function unitUserPrompt(input: UnitDraftInput): string {
  const f = input.facts;
  const data = {
    facts: {
      type: f.type === "HOUSE" ? "house" : "VIP tent", code: f.code, pricePerNightBaht: f.priceBaht, standardGuests: f.standardGuests,
      maxGuests: f.maxGuests, amenities: f.amenities, siteName: f.siteName, area: f.area,
    },
    currentTexts: input.texts,
  };
  return `Accommodation (JSON):\n${JSON.stringify(data)}\n\nAnswer with the JSON only.`;
}

const clean = (v: unknown, max: number, multiline = false): string | null => {
  if (typeof v !== "string") return null;
  let s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n");
  s = multiline ? s.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n") : s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length <= max) return s;
  // Cut at the last sentence / word end before the limit.
  const cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("。"), cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return (at > max * 0.6 ? cut.slice(0, at + 1) : cut).trim();
};

/** The AI's answer → a draft within the form's limits, or null when it is not the JSON asked for. */
export function parseUnitDraft(answer: string, _lang: LocaleCode): Omit<UnitTextDraftDto, "model"> | null {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(answer.slice(start, end + 1));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    o = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  const L = UNIT_TEXT_LIMITS;
  const name = clean(o.name, L.name);
  const shortDescription = clean(o.shortDescription, L.shortDescription);
  const description = clean(o.description, L.description, true);
  const seoTitle = clean(o.seoTitle, L.seoTitle);
  const seoDescription = clean(o.seoDescription, L.seoDescription);
  if (!name || !description) return null;
  return { name, shortDescription: shortDescription ?? "", description, seoTitle: seoTitle ?? "", seoDescription: seoDescription ?? "" };
}
