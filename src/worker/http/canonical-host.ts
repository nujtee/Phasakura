import type { Env } from "../env.ts";

/**
 * One public address (Phase 16): in production, a page or file requested on another host that reaches this
 * Worker (the apex when APP_BASE_URL is www, or the reverse; *.workers.dev if left on) is sent to APP_BASE_URL
 * with a 301, so Google sees one site and the `__Host-` session cookie lives on one host. API calls are never
 * redirected (a redirected POST would lose its body; the CSRF guard already pins them to their own origin).
 */
export function canonicalHostRedirect(request: Request, env: Env, url: URL): Response | null {
  if (env.APP_ENV !== "production" || (request.method !== "GET" && request.method !== "HEAD")) return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  const base = env.APP_BASE_URL?.trim();
  if (!base) return null;
  let target: URL;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.host === url.host) return null;
  return new Response(null, {
    status: 301,
    headers: { Location: `${target.origin}${url.pathname}${url.search}`, "Cache-Control": "public, max-age=3600" },
  });
}
