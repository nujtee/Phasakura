import { DEFAULT_LOCALE, parseLocale } from "../../shared/i18n/locales.ts";
import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { BadRequestError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { CMS_MAX_JSON_BYTES } from "./cms.controller.ts";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=60, s-maxage=300", Vary: "Accept-Encoding" } };

function lang(ctx: RequestContext) {
  const raw = ctx.url.searchParams.get("lang");
  const locale = raw === null ? DEFAULT_LOCALE : parseLocale(raw);
  if (!locale) throw new BadRequestError("Unsupported language", "UNSUPPORTED_LANGUAGE");
  return locale.code;
}

/** Website, branding, booking CTA, marketing, SEO, theme (admin) + public content reads. */
export function settingsController(services: ServicesFor) {
  return {
    website: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.website(auth, requestMeta(ctx)), NO_STORE)),
    saveWebsite: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).settings.saveWebsite(auth, await readJsonObject(ctx.request), requestMeta(ctx)))),

    branding: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.branding(auth, requestMeta(ctx)), NO_STORE)),
    saveBranding: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).settings.saveBranding(auth, await readJsonObject(ctx.request), requestMeta(ctx)))),

    bookingCta: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.bookingCta(auth, requestMeta(ctx)), NO_STORE)),
    saveBookingCta: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).settings.saveBookingCta(auth, await readJsonObject(ctx.request), requestMeta(ctx)))),

    marketing: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.marketing(auth, requestMeta(ctx)), NO_STORE)),
    saveMarketing: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).settings.saveMarketing(auth, await readJsonObject(ctx.request), requestMeta(ctx)))),

    seo: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.seo(auth, requestMeta(ctx)), NO_STORE)),
    saveSeo: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).settings.saveSeo(auth, ctx.params.pageKey ?? "", await readJsonObject(ctx.request, CMS_MAX_JSON_BYTES), requestMeta(ctx)))),

    theme: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.theme(auth, requestMeta(ctx)), NO_STORE)),
    themePreview: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.themePreview(auth, requestMeta(ctx)), NO_STORE)),
    saveThemeDraft: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).settings.saveThemeDraft(auth, await readJsonObject(ctx.request), requestMeta(ctx)))),
    discardThemeDraft: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.discardThemeDraft(auth, requestMeta(ctx)))),
    publishTheme: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).settings.publishTheme(auth, requestMeta(ctx)))),
    rollbackTheme: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).settings.rollbackTheme(auth, ctx.params.id ?? "", requestMeta(ctx)))),

    // ------------------------------------------------------------------ public content (spec §59)
    publicHome: (async (ctx) => jsonOk(await services(ctx).content.home(lang(ctx)), PUBLIC_CACHE)) satisfies Handler,
    publicSlides: (async (ctx) => jsonOk((await services(ctx).content.home(lang(ctx))).slides, PUBLIC_CACHE)) satisfies Handler,
    publicGallery: (async (ctx) => jsonOk(await services(ctx).content.gallery(lang(ctx)), PUBLIC_CACHE)) satisfies Handler,
    publicGalleryCategories: (async (ctx) => jsonOk((await services(ctx).content.gallery(lang(ctx))).categories, PUBLIC_CACHE)) satisfies Handler,
    publicHistory: (async (ctx) => jsonOk(await services(ctx).content.history(lang(ctx)), PUBLIC_CACHE)) satisfies Handler,
    publicTimeline: (async (ctx) => jsonOk((await services(ctx).content.history(lang(ctx))).timeline, PUBLIC_CACHE)) satisfies Handler,
  };
}
