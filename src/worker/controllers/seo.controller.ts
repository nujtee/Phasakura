import { resolveRoute } from "../../shared/routes.ts";
import type { Services } from "../container.ts";
import { NotFoundError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler } from "../router.ts";
import { requestMeta, withAuth } from "../http/auth-guard.ts";

const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=60, s-maxage=300", Vary: "Accept-Encoding" } };

export function seoController(services: (ctx: Parameters<Handler>[0]) => Services) {
  return {
    /** GET /api/public/meta?path=/th/gallery — metadata of a public page (redirects and admin pages have none). */
    meta: (async (ctx) => {
      const path = ctx.url.searchParams.get("path") ?? "";
      if (!/^\/(?![/\\])/.test(path) || path.length > 300) throw new ValidationError({ path: "INVALID_PATH" });
      const route = resolveRoute(path);
      if (route.kind !== "page" && route.kind !== "notFound") throw new NotFoundError("No metadata for this path", "PAGE_NOT_FOUND");
      return jsonOk(await services(ctx).seo.meta(route, path), PUBLIC_CACHE);
    }) satisfies Handler,

    /** GET /api/admin/i18n/coverage — visible content still missing EN / ZH-CN (content.view). */
    coverage: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).translations.coverage(auth, requestMeta(ctx)), { headers: { "Cache-Control": "no-store" } })),
  };
}
