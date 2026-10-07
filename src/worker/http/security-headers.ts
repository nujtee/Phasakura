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
export const PAGE_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
};

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
