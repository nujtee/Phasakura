/**
 * Builds public URLs for objects in the PUBLIC R2 bucket only.
 * Private objects (payment slips) must never go through this helper.
 */

// Object keys we generate look like "branding/logo-main/2026/09/<uuid>.webp".
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,511}$/;

export function isSafeObjectKey(key: string): boolean {
  return SAFE_KEY.test(key) && !key.includes("..") && !key.includes("//");
}

function normalizeBaseUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) return null;
  return url.href.replace(/\/+$/, "");
}

/**
 * @returns absolute URL on the media domain when configured, otherwise a
 *          same-origin `/media/<key>` path (served by the Worker in Phase 12).
 *          Returns null for unsafe keys.
 */
export function publicMediaUrl(key: string | null | undefined, baseUrl?: string): string | null {
  if (!key || !isSafeObjectKey(key)) return null;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const base = normalizeBaseUrl(baseUrl);
  return base ? `${base}/${encodedKey}` : `/media/${encodedKey}`;
}
