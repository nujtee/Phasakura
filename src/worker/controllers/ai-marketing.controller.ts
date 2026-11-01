import { REPORT_KINDS, type AiMarketingSettingsInput } from "../../shared/ai-marketing-types.ts";
import { AI_DRAFT_MODES, UNIT_TEXT_LIMITS } from "../../shared/ai-content-types.ts";
import { getLocale, LOCALES, parseLocale, type LocaleCode } from "../../shared/i18n/locales.ts";
import type { UnitDraftInput } from "../ai-marketing/content-writer.ts";
import { POST_CHANNELS, POST_NOTE_MAX, POST_OFFER_MAX } from "../../shared/ai-post-types.ts";
import { trackedLink } from "../ai-marketing/post-writer.ts";
import { diffDays } from "../../shared/dates.ts";
import { isIsoDate } from "../../shared/dates.ts";
import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import { readJsonObject } from "../security/request.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const NO_STORE = { "Cache-Control": "no-store" };
/** Monthly AI budget: 0 – 100,000 THB. */
const MAX_BUDGET_SATANG = 10_000_000;

/** AI marketing report (migration 0053): list / read (reports.view), ask for one and settings (marketing.*). */
export function aiMarketingController(services: ServicesFor) {
  return {
    list: withPermission("reports.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).aiMarketing.list(auth, requestMeta(ctx)), { headers: NO_STORE })),

    get: withPermission("reports.view", services, async (ctx, auth) => {
      const id = ctx.params.id ?? "";
      if (!ID_PATTERN.test(id)) throw new ValidationError({ id: "INVALID_ID" });
      return jsonOk(await services(ctx).aiMarketing.get(auth, id, requestMeta(ctx)), { headers: NO_STORE });
    }),

    generate: withPermission("marketing.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["kind", "periodStart"]);
      const kind = v.oneOf("kind", REPORT_KINDS, { required: true });
      const periodStart = v.string("periodStart", { max: 10 });
      if (periodStart !== undefined && !isIsoDate(periodStart)) v.errors.periodStart = "INVALID_DATE";
      v.assertValid();
      return jsonOk(await services(ctx).aiMarketing.generate(auth, { kind: kind!, periodStart }, requestMeta(ctx)), { status: 201, headers: NO_STORE });
    }),

    /** POST /api/admin/accommodations/:id/ai-draft — Module B: the AI drafts this unit's texts in one language (not saved). */
    unitDraft: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const id = ctx.params.id ?? "";
      if (!ID_PATTERN.test(id)) throw new ValidationError({ id: "INVALID_ID" });
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["lang", "mode", "texts"]);
      const lang = parseLocale(v.string("lang", { required: true, max: 10 }) ?? "")?.code;
      if (!lang) v.errors.lang = "INVALID_VALUE";
      const mode = v.oneOf("mode", AI_DRAFT_MODES, { required: true });
      const sent: UnitDraftInput["texts"] = {};
      if (body.texts !== undefined) {
        if (typeof body.texts !== "object" || body.texts === null || Array.isArray(body.texts)) v.errors.texts = "INVALID_VALUE";
        else {
          for (const [code, raw] of Object.entries(body.texts as Record<string, unknown>)) {
            const loc = parseLocale(code)?.code;
            if (!loc || typeof raw !== "object" || raw === null) { v.errors.texts = "INVALID_VALUE"; continue; }
            const tv = new Validator(raw as Record<string, unknown>).allowOnly(["name", "shortDescription", "description", "seoTitle", "seoDescription"]);
            sent[loc] = {
              name: tv.string("name", { max: UNIT_TEXT_LIMITS.name }) ?? "",
              shortDescription: tv.string("shortDescription", { max: UNIT_TEXT_LIMITS.shortDescription }) ?? null,
              description: tv.string("description", { max: UNIT_TEXT_LIMITS.description, raw: true })?.trim() || null,
              seoTitle: tv.string("seoTitle", { max: UNIT_TEXT_LIMITS.seoTitle }) ?? null,
              seoDescription: tv.string("seoDescription", { max: UNIT_TEXT_LIMITS.seoDescription }) ?? null,
            };
            if (Object.keys(tv.errors).length) v.errors.texts = "INVALID_VALUE";
          }
        }
      }
      v.assertValid();
      const s = services(ctx);
      const meta = requestMeta(ctx);
      const unit = await s.accommodation.get(auth, id, meta);
      const amenities = await s.accommodation.listAmenities(auth, meta).catch(() => []);
      const site = await s.site.getPublicSite(getLocale(lang!));
      const texts: UnitDraftInput["texts"] = {};
      for (const l of LOCALES) {
        const saved = unit.translations[l.code as LocaleCode];
        const t = sent[l.code as LocaleCode] ?? (saved ? { ...saved } : undefined);
        if (t && (t.name || t.description || t.shortDescription)) texts[l.code as LocaleCode] = t;
      }
      if (mode === "TRANSLATE" && !texts.th?.name) throw new ValidationError({ mode: "THAI_TEXT_REQUIRED" });
      const draft = await s.aiMarketing.draftUnitText(auth, {
        lang: lang!, mode: mode!, texts,
        facts: {
          unitId: unit.id, type: unit.unitType, code: unit.unitCode, priceBaht: Math.round(unit.basePriceSatang / 100),
          standardGuests: unit.standardGuests, maxGuests: unit.maxGuests,
          amenities: amenities.filter((a) => unit.amenityIds.includes(a.id)).map((a) => a.names[lang!] || a.names.th || a.code).slice(0, 40),
          siteName: site.siteName ?? null, area: site.contact.address?.slice(0, 160) ?? null,
        },
      }, meta);
      return jsonOk(draft, { headers: NO_STORE });
    }),

    /** GET /api/admin/ai-marketing/quiet-dates?lang= — Module C: quiet runs / empty days of the next 60 days + units. */
    quietDates: withPermission("marketing.view", services, async (ctx, auth) => {
      const lang = parseLocale(ctx.url.searchParams.get("lang") ?? "th")?.code ?? "th";
      return jsonOk(await services(ctx).aiMarketing.quietDates(auth, lang, requestMeta(ctx)), { headers: NO_STORE });
    }),

    /** POST /api/admin/ai-marketing/post-drafts — Module C: three drafts of a post / LINE message; nothing posted. */
    postDrafts: withPermission("marketing.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["channel", "lang", "from", "to", "unitId", "offer", "note"]);
      const channel = v.oneOf("channel", POST_CHANNELS, { required: true });
      const lang = parseLocale(v.string("lang", { required: true, max: 10 }) ?? "")?.code;
      if (!lang) v.errors.lang = "INVALID_VALUE";
      const from = v.string("from", { max: 10 });
      const to = v.string("to", { max: 10 });
      if (from !== undefined && !isIsoDate(from)) v.errors.from = "INVALID_DATE";
      if (to !== undefined && !isIsoDate(to)) v.errors.to = "INVALID_DATE";
      if ((from === undefined) !== (to === undefined)) v.errors[from === undefined ? "from" : "to"] = "REQUIRED";
      if (from && to && isIsoDate(from) && isIsoDate(to) && (to < from || diffDays(from, to) > 90)) v.errors.to = "INVALID_RANGE";
      const unitId = v.string("unitId", { pattern: ID_PATTERN });
      const offer = v.string("offer", { max: POST_OFFER_MAX }) ?? null;
      const note = v.string("note", { max: POST_NOTE_MAX }) ?? null;
      v.assertValid();
      const s = services(ctx);
      const meta = requestMeta(ctx);
      const units = await s.aiMarketing.postUnits(lang!, unitId ?? null);
      if (unitId && !units.length) throw new ValidationError({ unitId: "NOT_BOOKABLE" });
      const site = await s.site.getPublicSite(getLocale(lang!));
      const link = trackedLink(ctx.url.origin, lang!, channel!, { from: from ?? null, unitSlug: unitId ? units[0]!.slug : null, today: await s.aiMarketing.today() });
      const draft = await s.aiMarketing.draftPost(auth, {
        channel: channel!, lang: lang!, link,
        facts: {
          siteName: site.siteName ?? null, area: site.contact.address?.slice(0, 160) ?? null,
          dates: from && to ? { from, to, nights: diffDays(from, to) + 1, freeUnits: null } : null,
          units: units.map((u) => ({ name: u.name, type: u.unit_type, maxGuests: u.max_guests, priceBaht: Math.round(u.base_price_satang / 100), shortDescription: u.short_description })),
          offer, note,
        },
      }, meta);
      return jsonOk(draft, { headers: NO_STORE });
    }),

    settings: withPermission("marketing.view", services, async (ctx, auth) =>
      jsonOk(await services(ctx).aiMarketing.settings(auth, requestMeta(ctx)), { headers: NO_STORE })),

    saveSettings: withPermission("marketing.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["enabled", "aiEnabled", "monthlyBudgetSatang", "notifyEmail", "notifyLine"]);
      const input: AiMarketingSettingsInput = {};
      for (const k of ["enabled", "aiEnabled", "notifyEmail", "notifyLine"] as const) if (v.has(k)) input[k] = v.boolean(k, false);
      if (v.has("monthlyBudgetSatang")) {
        const b = body.monthlyBudgetSatang;
        if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > MAX_BUDGET_SATANG) v.errors.monthlyBudgetSatang = "INVALID_VALUE";
        else input.monthlyBudgetSatang = b;
      }
      v.assertValid();
      return jsonOk(await services(ctx).aiMarketing.updateSettings(auth, input, requestMeta(ctx)), { headers: NO_STORE });
    }),
  };
}
