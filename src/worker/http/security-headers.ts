/**
 * Security headers for every API response.
 * Static assets get their headers from `public/_headers`.
 */
const API_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export function withSecurityHeaders(response: Response, requestId: string): Response {
  // Responses from fetch() can have immutable headers; copy into a new Response.
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  // API data is private by default. Public endpoints opt in to caching explicitly.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  // JSON is data for the pages, never a search result of its own (robots.txt lets crawlers fetch the public
  // endpoints so they can render the pages). Images and other files are not touched.
  if ((headers.get("Content-Type") ?? "").startsWith("application/json")) headers.set("X-Robots-Tag", "noindex");
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Headers for HTML pages rendered by the Worker (Phase 13). Same policy as the static assets in
 * `public/_headers` (kept identical by a test), so moving page rendering into the Worker changes
 * nothing for the browser.
 */
/** The policy with nothing from outside this site (the back office starts from it). */
const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

/**
 * Cloudflare Web Analytics: Cloudflare itself adds its beacon script to the pages of a zone where the owner
 * switched it on (no cookies). Public pages allow that script and where it reports to; without this the browser
 * blocks it and logs an error on every page. Sites without Web Analytics get no script, so nothing changes there.
 */
const CLOUDFLARE_INSIGHTS = { script: "https://static.cloudflareinsights.com", connect: "https://cloudflareinsights.com" } as const;

export const PAGE_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": STRICT_CSP
    .replace("script-src 'self'", `script-src 'self' ${CLOUDFLARE_INSIGHTS.script}`)
    .replace("connect-src 'self'", `connect-src 'self' ${CLOUDFLARE_INSIGHTS.connect}`),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * The back office only: WebAssembly may be compiled ('wasm-unsafe-eval' allows that and nothing else — no eval,
 * no inline script), and nothing from outside this site: the back office is not measured. Photos uploaded from a browser whose canvas cannot write WebP (Safari on iPad / iPhone) are
 * encoded by a WebAssembly encoder served from this site. Public pages keep the stricter policy.
 */
export const ADMIN_PAGE_CSP = STRICT_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");

/** Third-party origins a tracker needs; added to the page CSP only while that tracker is switched on. */
const TRACKER_SOURCES = {
  ga4: {
    script: ["https://www.googletagmanager.com"],
    // Google's CSP guide for GA4; doubleclick / google.com only carry Google signals (Marketing consent).
    connect: ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com", "https://*.g.doubleclick.net", "https://www.google.com"],
  },
  pixel: {
    script: ["https://connect.facebook.net"],
    connect: ["https://www.facebook.com", "https://connect.facebook.net"],
  },
} as const;

/**
 * Page headers with the CSP widened for the trackers that are on (Phase 14). The scripts are still
 * loaded only after consent, by the app; with both trackers off this is exactly PAGE_SECURITY_HEADERS.
 */
export function pageSecurityHeaders(tracking: { ga4: boolean; pixel: boolean }): Record<string, string> {
  const extra = { script: [] as string[], connect: [] as string[] };
  if (tracking.ga4) { extra.script.push(...TRACKER_SOURCES.ga4.script); extra.connect.push(...TRACKER_SOURCES.ga4.connect); }
  if (tracking.pixel) { extra.script.push(...TRACKER_SOURCES.pixel.script); extra.connect.push(...TRACKER_SOURCES.pixel.connect); }
  if (!extra.script.length) return PAGE_SECURITY_HEADERS;
  const csp = PAGE_SECURITY_HEADERS["Content-Security-Policy"]!
    .replace("script-src 'self'", `script-src 'self' ${extra.script.join(" ")}`)
    .replace("connect-src 'self'", `connect-src 'self' ${extra.connect.join(" ")}`);
  return { ...PAGE_SECURITY_HEADERS, "Content-Security-Policy": csp };
}

/** base64 SHA-256 of an inline style sheet, for `style-src 'sha256-…'`. */
export async function styleHash(css: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** The same headers, allowing exactly one inline style sheet (by its hash); nothing else inline. */
export function withInlineStyle(headers: Record<string, string>, hash: string): Record<string, string> {
  return { ...headers, "Content-Security-Policy": headers["Content-Security-Policy"]!.replace("style-src 'self'", `style-src 'self' 'sha256-${hash}'`) };
}
