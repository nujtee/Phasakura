import { DEFAULT_LOCALE, parseLocale } from "../../shared/i18n/locales.ts";
import type { Services } from "../container.ts";
import { requestMeta, withAuth } from "../http/auth-guard.ts";
import { BadRequestError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler } from "../router.ts";
import { readJsonObject } from "../security/request.ts";

function locale(ctx: Parameters<Handler>[0]) {
  const raw = ctx.url.searchParams.get("lang");
  const l = raw === null ? DEFAULT_LOCALE : parseLocale(raw);
  if (!l) throw new BadRequestError("Unsupported language", "UNSUPPORTED_LANGUAGE");
  return l;
}

export function searchController(services: (ctx: Parameters<Handler>[0]) => Services) {
  return {
    /** GET /api/search?q=&lang=&checkIn=&checkOut=&guests= — public; with dates the answer is live (never cached). */
    search: (async (ctx) => {
      const p = ctx.url.searchParams;
      const guestsRaw = p.get("guests");
      const guests = guestsRaw === null || guestsRaw === "" ? null : Number(guestsRaw);
      if (guests !== null && (!Number.isInteger(guests) || guests < 1 || guests > 50)) throw new ValidationError({ guests: "OUT_OF_RANGE" });
      const checkIn = p.get("checkIn") || null;
      const checkOut = p.get("checkOut") || null;
      const result = await services(ctx).search.search({ q: p.get("q"), lang: locale(ctx), checkIn, checkOut, guests });
      return jsonOk(result, { headers: { "Cache-Control": checkIn ? "no-store" : "private, max-age=30" } });
    }) satisfies Handler,

    /** POST /api/search/click { q, lang } — a result was opened (anonymous count). */
    click: (async (ctx) => {
      const body = await readJsonObject(ctx.request);
      const q = typeof body.q === "string" ? body.q : "";
      const l = parseLocale(typeof body.lang === "string" ? body.lang : null) ?? DEFAULT_LOCALE;
      await services(ctx).search.click(q, l.code);
      return jsonOk({ ok: true });
    }) satisfies Handler,

    /** GET /api/admin/search/analytics?days=30 (seo.edit) */
    analytics: withAuth(services, async (ctx, auth) => {
      const days = Number(ctx.url.searchParams.get("days") ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new ValidationError({ days: "OUT_OF_RANGE" });
      return jsonOk(await services(ctx).search.analytics(auth, days, requestMeta(ctx)));
    }),

    /** POST /api/admin/search/reindex (seo.edit, audited) */
    reindex: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).search.reindex(auth, requestMeta(ctx)))),
  };
}
