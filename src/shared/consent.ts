/**
 * Cookie consent (spec §46). One first-party cookie records the visitor's choice:
 *   pk_consent=<version>.<analytics 0|1>.<marketing 0|1>.<unix seconds>
 * Necessary cookies (session, this one) need no consent. Analytics (GA4) and Marketing
 * (Meta Pixel / Conversions API) run only after the matching category was accepted for the
 * current consent version; raising the version (Settings → Privacy) asks everyone again.
 */
export const CONSENT_COOKIE = "pk_consent";
export const CONSENT_CATEGORIES = ["necessary", "analytics", "marketing"] as const;

export interface ConsentState {
  version: number;
  analytics: boolean;
  marketing: boolean;
  /** When the choice was made (unix seconds). */
  at: number;
}

const FORMAT = /^(\d{1,4})\.([01])\.([01])\.(\d{1,12})$/;

export function serializeConsent(c: ConsentState): string {
  return `${c.version}.${c.analytics ? 1 : 0}.${c.marketing ? 1 : 0}.${Math.floor(c.at)}`;
}

export function parseConsent(value: string | null | undefined): ConsentState | null {
  const m = value ? FORMAT.exec(value.trim()) : null;
  if (!m) return null;
  return { version: Number(m[1]), analytics: m[2] === "1", marketing: m[3] === "1", at: Number(m[4]) };
}

/** A cookie value from a `Cookie` header (any format; callers validate). */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The visitor's choice for the current version, or null (not asked yet / asked for an older version). */
export function currentConsent(header: string | null | undefined, version: number): ConsentState | null {
  const c = parseConsent(cookieValue(header, CONSENT_COOKIE));
  return c && c.version === version ? c : null;
}

/** Meta browser ids set by the Pixel: _fbp = fb.1.<ms>.<random>, _fbc = fb.1.<ms>.<fbclid>. */
const FB_ID = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_\-.]{1,250}$/;

export function metaBrowserIds(header: string | null | undefined): { fbp: string | null; fbc: string | null } {
  const ok = (v: string | null) => (v && FB_ID.test(v) ? v : null);
  return { fbp: ok(cookieValue(header, "_fbp")), fbc: ok(cookieValue(header, "_fbc")) };
}
