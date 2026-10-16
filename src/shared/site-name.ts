/**
 * The site's short name, taken from its own domain, for the few places code needs one (file names, the
 * User-Agent of outgoing requests, examples in the admin). Every site runs the same code (Center phase C0),
 * so none of these may say "Phasakura": phasakura.com → "phasakura", www.chomkhao.com → "chomkhao".
 */
export function siteSlug(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {
    return "site";
  }
  const label = host.replace(/^www\./, "").split(".")[0] ?? "";
  return /^[a-z0-9-]{1,63}$/.test(label) && !/^(localhost|\d+)$/.test(label) ? label : "site";
}

/** "phasakura" → "Phasakura". */
export function siteLabel(urlOrHost: string): string {
  const slug = siteSlug(urlOrHost);
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Mail domain for examples: the site's host without "www." (falls back to "your-domain.com"). */
export function siteMailDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : "your-domain.com";
}
