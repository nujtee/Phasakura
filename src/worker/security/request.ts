import { ForbiddenError, PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from "../http/errors.ts";

/** Header every state-changing request from our frontend sends. Forces a CORS preflight cross-site. */
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_HEADER_VALUE = "phasakura";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth (cookie is also SameSite=Strict):
 * 1. Origin (or Sec-Fetch-Site) must be same-origin for unsafe methods.
 * 2. The custom header must be present (cannot be sent cross-site without preflight).
 */
export function assertSameOriginRequest(request: Request, url: URL): void {
  if (SAFE_METHODS.has(request.method)) return;

  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (origin !== null) {
    if (origin !== url.origin) throw new ForbiddenError("Cross-origin request blocked", "CSRF_ORIGIN_MISMATCH");
  } else if (fetchSite !== null && fetchSite !== "same-origin") {
    throw new ForbiddenError("Cross-site request blocked", "CSRF_ORIGIN_MISMATCH");
  } else if (origin === null && fetchSite === null) {
    throw new ForbiddenError("Missing Origin header", "CSRF_ORIGIN_MISSING");
  }

  if (request.headers.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    throw new ForbiddenError("Missing CSRF header", "CSRF_HEADER_MISSING");
  }
}

export const MAX_JSON_BYTES = 16 * 1024;

/** Reads a JSON object body with Content-Type and size checks. */
export async function readJsonObject(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new UnsupportedMediaTypeError();

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new PayloadTooLargeError();

  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new PayloadTooLargeError();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError({ body: "INVALID_JSON" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError({ body: "EXPECTED_OBJECT" });
  }
  return body as Record<string, unknown>;
}

export function clientIp(request: Request): string | null {
  const ip = request.headers.get("CF-Connecting-IP");
  return ip && ip.length <= 64 ? ip : null;
}

export function userAgent(request: Request): string | null {
  const ua = request.headers.get("User-Agent");
  return ua ? ua.slice(0, 512) : null;
}
