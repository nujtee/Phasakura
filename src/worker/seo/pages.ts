import { DEFAULT_LOCALE, negotiateLocale } from "../../shared/i18n/locales.ts";
import { pagePath, resolveRoute } from "../../shared/routes.ts";
import type { Services } from "../container.ts";
import type { Env } from "../env.ts";
import { PAGE_SECURITY_HEADERS, pageSecurityHeaders } from "../http/security-headers.ts";
import { escapeHtml, injectHead } from "./html.ts";

/** Paths that are never pages (and never redirect targets of Website → SEO → Redirects). */
const RESERVED = /^\/(api|media|assets)(\/|$)/;
/** A file name at the end of the path: not a page (no app shell for /wp-login.php or /x.png). */
const FILE_LIKE = /\/[^/]*\.[A-Za-z0-9]{1,8}$/;

function logToConsole(message: string, error: unknown) {
  console.error(JSON.stringify({ level: "error", message, error: String(error).slice(0, 300) }));
}

function withHeaders(body: BodyInit | null, status: number, headers: Record<string, string>, head: boolean): Response {
  return new Response(head ? null : body, { status, headers: { ...PAGE_SECURITY_HEADERS, ...headers } });
}

function text(status: number, body: string, head: boolean, headers: Record<string, string> = {}): Response {
  return withHeaders(body, status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300", ...headers }, head);
}

/** Same-site redirect only: the target must be a path ("/x"), never "//host" or "/\host". */
function redirect(status: number, to: string, search: string, head: boolean, headers: Record<string, string> = {}): Response {
  const safe = /^\/(?![/\\])/.test(to) ? to : "/";
  const location = search && !safe.includes("?") ? `${safe}${search}` : safe;
  return withHeaders(null, status, { Location: location, "Cache-Control": "public, max-age=300", ...headers }, head);
}

/**
 * Every non-API, non-media request (Phase 13): robots.txt, sitemap.xml, admin redirects, route
 * normalisation, and the app shell with this page's metadata in <head> — the right status code
 * (404 for unknown pages), `<html lang>`, title, description, canonical, hreflang, Open Graph,
 * JSON-LD. If metadata cannot be built, the plain app shell is served (the site never goes down
 * because of SEO).
 */
export function createPageHandler(servicesFor: (request: Request, env: Env, url: URL) => Services) {
  async function template(env: Env, url: URL): Promise<string | null> {
    const res = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), { headers: { Accept: "text/html" } }));
    return res.ok ? res.text() : null;
  }

  return async function servePage(request: Request, env: Env, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path.startsWith("/assets/")) return env.ASSETS.fetch(request);
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) return text(405, "Method not allowed", false, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    const s = servicesFor(request, env, url);
    // Console (Workers Observability) + the owner's error log (System status).
    const log = (message: string, error: unknown) => {
      logToConsole(message, error);
      return s.monitoring.recordError({ source: "PAGE", error, method: request.method, path, context: message });
    };
    const production = env.APP_ENV === "production";
    const noindex: Record<string, string> = { "X-Robots-Tag": "noindex, nofollow" };

    try {
      if (path === "/robots.txt") return text(200, s.seo.robotsTxt(), head, { "Cache-Control": "public, max-age=3600" });
      if (path === "/sitemap.xml") {
        return withHeaders(await s.seo.sitemapXml(), 200, {
          "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600", ...(production ? {} : noindex),
        }, head);
      }
      if (path === "/favicon.ico") {
        const favicon = (await s.site.getPublicSite(DEFAULT_LOCALE)).favicon;
        if (favicon && /^(https:\/\/|\/(?![/\\]))/.test(favicon)) {
          return withHeaders(null, 302, { Location: favicon, "Cache-Control": "public, max-age=3600" }, head);
        }
        return text(404, "Not found", head, noindex);
      }
    } catch (error) {
      await log("seo_file_failed", error);
      return text(503, "Temporarily unavailable", head, { "Cache-Control": "no-store", "Retry-After": "60" });
    }

    // Website → SEO → Redirects: exact path, before any page logic (admin and system paths excluded).
    if (!RESERVED.test(path) && !/^\/([a-z-]+\/)?admin(\/|$)/i.test(path)) {
      try {
        const r = await s.seo.redirectFor(path);
        if (r) return redirect(r.status, r.to, url.search, head);
      } catch (error) {
        await log("seo_redirect_failed", error);
      }
    }

    const route = resolveRoute(path);
    if (route.kind === "redirect") {
      // The bare entry URL picks the visitor's language; everything else is a permanent canonical fix.
      if (path === "/") {
        const locale = negotiateLocale(request.headers.get("Accept-Language"));
        return redirect(302, pagePath(locale, "home"), url.search, head, { Vary: "Accept-Language", "Cache-Control": "private, no-cache" });
      }
      return redirect(/^\/admin(\/|$)/.test(path) ? 302 : 301, route.to, url.search, head);
    }
    if (FILE_LIKE.test(path)) return text(404, "Not found", head, noindex);

    const shell = await template(env, url).catch(async (error: unknown) => { await log("app_shell_failed", error); return null; });
    if (shell === null) return env.ASSETS.fetch(request);

    if (route.kind === "admin") {
      const html = shell
        .replace(/<html\b[^>]*>/i, () => `<html lang="${escapeHtml(route.locale.code)}">`)
        .replace(/<\/head>/i, () => '    <meta name="robots" content="noindex, nofollow" />\n  </head>');
      return withHeaders(html, 200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...noindex,
      }, head);
    }

    try {
      const meta = await s.seo.meta(route, path);
      const indexable = meta.robots.startsWith("index");
      const tracking = (await s.site.getPublicSite(route.locale)).tracking;
      return withHeaders(injectHead(shell, meta), meta.status, {
        // GA4 / Pixel origins only while they are switched on (the app still waits for consent).
        ...pageSecurityHeaders({ ga4: !!tracking.ga4MeasurementId, pixel: !!tracking.metaPixelId }),
        "Content-Type": "text/html; charset=utf-8",
        "Content-Language": meta.lang,
        // HTML always revalidates (content and hashed asset names change on deploy).
        "Cache-Control": indexable ? "public, no-cache" : "no-store",
        ...(indexable ? {} : noindex),
      }, head);
    } catch (error) {
      await log("page_meta_failed", error);
      return withHeaders(shell, route.kind === "notFound" ? 404 : 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, head);
    }
  };
}
