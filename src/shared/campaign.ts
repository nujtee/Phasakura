/**
 * Where a booking came from (migration 0052): the first page of the visitor's browser tab — UTM tags, the
 * referring site's host name and the landing path. Read in the browser, sent with the booking, cleaned again
 * on the server. Nothing in it identifies a person: no query string, no IP, no click ID value — only whether
 * the visit came from a Google (gclid) or Meta (fbclid) ad click.
 */
export const CLICK_KINDS = ["GCLID", "FBCLID", "NONE"] as const;
export type ClickKind = (typeof CLICK_KINDS)[number];

export interface CampaignDto {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  clickKind: ClickKind;
  /** When the tab first landed (ISO). */
  firstSeenAt: string | null;
}

const TAG_MAX = 100;
const PATH_MAX = 200;
const HOST = /^(?=.{1,100}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A UTM value: lower case, letters / digits / a few separators, ≤ 100 characters; null when nothing is left. */
export function cleanTag(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N} ._\-+/:|()]/gu, "").replace(/\s+/g, " ").trim().slice(0, TAG_MAX).trim();
  return s || null;
}

/** A host name (no "www."), or null. */
export function cleanHost(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return HOST.test(s) ? s : null;
}

/** A path on this site, without query or fragment, ≤ 200 characters; null otherwise. */
export function cleanPath(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//")) return null;
  const s = v.split(/[?#]/)[0]!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, PATH_MAX);
  return s || null;
}

/** What the browser sent, cleaned; never throws. null when it carries nothing usable. */
export function sanitizeCampaign(v: unknown): CampaignDto | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const clickKind = (CLICK_KINDS as readonly unknown[]).includes(o.clickKind) ? (o.clickKind as ClickKind) : "NONE";
  const firstSeenAt = typeof o.firstSeenAt === "string" && ISO.test(o.firstSeenAt) && !Number.isNaN(Date.parse(o.firstSeenAt)) ? o.firstSeenAt : null;
  const c: CampaignDto = {
    utmSource: cleanTag(o.utmSource),
    utmMedium: cleanTag(o.utmMedium),
    utmCampaign: cleanTag(o.utmCampaign),
    utmTerm: cleanTag(o.utmTerm),
    utmContent: cleanTag(o.utmContent),
    referrerHost: cleanHost(o.referrerHost),
    landingPath: cleanPath(o.landingPath),
    clickKind,
    firstSeenAt,
  };
  const any = c.utmSource || c.utmMedium || c.utmCampaign || c.utmTerm || c.utmContent || c.referrerHost || c.landingPath || c.clickKind !== "NONE";
  return any ? c : null;
}

/**
 * The first touch of a page load: `href` = the page's URL, `referrer` = document.referrer.
 * The referrer only counts when it is another site (own pages and the site's own sub-domains are not a source).
 */
export function campaignFromLanding(href: string, referrer: string, nowIso: string): CampaignDto | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const q = url.searchParams;
  let referrerHost: string | null = null;
  try {
    const ref = referrer ? new URL(referrer) : null;
    const own = cleanHost(url.hostname);
    const host = ref && /^https?:$/.test(ref.protocol) ? cleanHost(ref.hostname) : null;
    if (host && own && host !== own && !host.endsWith(`.${own}`) && !own.endsWith(`.${host}`)) referrerHost = host;
  } catch {
    referrerHost = null;
  }
  return sanitizeCampaign({
    utmSource: q.get("utm_source"),
    utmMedium: q.get("utm_medium"),
    utmCampaign: q.get("utm_campaign"),
    utmTerm: q.get("utm_term"),
    utmContent: q.get("utm_content"),
    referrerHost,
    landingPath: url.pathname,
    clickKind: q.has("gclid") || q.has("gbraid") || q.has("wbraid") ? "GCLID" : q.has("fbclid") ? "FBCLID" : "NONE",
    firstSeenAt: nowIso,
  });
}

/** Whether a landing carries a real source (tags, another site or an ad click) — such a landing replaces a plain one. */
export function hasSource(c: CampaignDto | null): boolean {
  return !!c && !!(c.utmSource || c.utmMedium || c.utmCampaign || c.referrerHost || c.clickKind !== "NONE");
}

const SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex|naver|ecosia|search\.brave)\./;
const SOCIAL = /(^|\.)(facebook|fb|instagram|messenger|line|tiktok|twitter|x|t|youtube|pinterest|threads|linkedin|reddit)\.(com|me|co|net|th|co\.th)$/;
const HOST_PREFIX = /^(m|l|lm|mobile|web|business)\./;

/** The site's short name from a host: "l.facebook.com" → "facebook", "google.co.th" → "google". */
function siteName(host: string): string {
  const h = host.replace(HOST_PREFIX, "");
  const parts = h.split(".");
  // name.co.th / name.com.au → name; name.com → name; sub.name.com → name
  const tld2 = parts.length >= 3 && /^(co|com|net|or|ac|go|in)$/.test(parts[parts.length - 2]!);
  return parts[parts.length - (tld2 ? 3 : 2)] ?? h;
}

/** Source / medium of a booking, like GA4's "session source / medium". */
export function sourceMedium(c: Pick<CampaignDto, "utmSource" | "utmMedium" | "referrerHost" | "clickKind"> | null): { source: string; medium: string } {
  if (!c) return { source: "(direct)", medium: "(none)" };
  if (c.utmSource) return { source: c.utmSource, medium: c.utmMedium ?? (c.clickKind === "GCLID" ? "cpc" : "(not set)") };
  if (c.clickKind === "GCLID") return { source: "google", medium: "cpc" };
  if (c.referrerHost) {
    const name = siteName(c.referrerHost);
    if (SEARCH.test(c.referrerHost)) return { source: name, medium: "organic" };
    if (c.clickKind === "FBCLID" || SOCIAL.test(c.referrerHost)) return { source: name, medium: "social" };
    return { source: c.referrerHost, medium: "referral" };
  }
  if (c.clickKind === "FBCLID") return { source: "facebook", medium: "social" };
  return { source: "(direct)", medium: "(none)" };
}
