import { parseLocale, DEFAULT_LOCALE } from "../../shared/i18n/locales.ts";
import type { Services } from "../container.ts";
import { BadRequestError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler } from "../router.ts";

export function siteController(services: (ctx: Parameters<Handler>[0]) => Services) {
  return {
    /** GET /api/public/site?lang=th|en|zh-cn — public, cacheable, no PII. */
    getPublicSite: (async (ctx) => {
      const raw = ctx.url.searchParams.get("lang");
      const locale = raw === null ? DEFAULT_LOCALE : parseLocale(raw);
      if (!locale) throw new BadRequestError("Unsupported language", "UNSUPPORTED_LANGUAGE");

      const site = await services(ctx).site.getPublicSite(locale);
      return jsonOk(site, {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300",
          Vary: "Accept-Encoding",
        },
      });
    }) satisfies Handler,
  };
}
