import type { PageMetaDto } from "../../shared/seo-types.ts";

/** Text / attribute escaping for everything that goes into the HTML head. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * JSON for an inline application/ld+json block. `<`, `>` and `&` are escaped as <… so
 * content (or an admin's schema text) can never close the <script> element or open a comment.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

const meta = (attr: "name" | "property", key: string, content: string | null | undefined) =>
  content ? `<meta ${attr}="${key}" content="${escapeHtml(content)}" data-seo />` : "";

/** Head tags for a page. Every tag carries `data-seo` so the client can replace them on navigation. */
export function renderHeadTags(m: PageMetaDto): string {
  const tags: string[] = [
    `<title>${escapeHtml(m.title)}</title>`,
    meta("name", "description", m.description),
    meta("name", "robots", m.robots.replace(",", ", ")),
    m.canonical ? `<link rel="canonical" href="${escapeHtml(m.canonical)}" data-seo />` : "",
    ...m.alternates.map((a) => `<link rel="alternate" hreflang="${escapeHtml(a.hreflang)}" href="${escapeHtml(a.href)}" data-seo />`),
    meta("property", "og:type", m.og.type),
    meta("property", "og:site_name", m.og.siteName),
    meta("property", "og:title", m.og.title),
    meta("property", "og:description", m.og.description),
    meta("property", "og:url", m.og.url),
    meta("property", "og:locale", m.og.locale),
    ...m.og.localeAlternates.map((l) => meta("property", "og:locale:alternate", l)),
  ];
  if (m.og.image) {
    tags.push(
      meta("property", "og:image", m.og.image.url),
      m.og.image.width ? meta("property", "og:image:width", String(m.og.image.width)) : "",
      m.og.image.height ? meta("property", "og:image:height", String(m.og.image.height)) : "",
      meta("property", "og:image:alt", m.og.image.alt),
    );
  }
  tags.push(
    meta("name", "twitter:card", m.og.image ? "summary_large_image" : "summary"),
    meta("name", "twitter:title", m.og.title),
    meta("name", "twitter:description", m.og.description),
    m.og.image ? meta("name", "twitter:image", m.og.image.url) : "",
    meta("name", "google-site-verification", m.googleSiteVerification),
    // No data-seo: the client keeps the favicon (SiteProvider owns it after load).
    m.favicon ? `<link rel="icon" href="${escapeHtml(m.favicon)}" />` : "",
    ...m.jsonLd.map((d) => `<script type="application/ld+json" data-seo>${jsonForScript(d)}</script>`),
  );
  return tags.filter(Boolean).join("\n    ");
}

/**
 * The built index.html with this page's head: `<html lang>`, a `data-seo-path` marker (the client
 * skips re-fetching metadata on first load), the title and the tags above. The template's own
 * empty <title> and placeholder favicon are replaced, everything else is kept byte for byte.
 */
export function injectHead(template: string, m: PageMetaDto): string {
  // Function replacements: "$&" or "$1" in content must never be read as replacement patterns.
  let html = template.replace(/<html\b[^>]*>/i, () => `<html lang="${escapeHtml(m.lang)}" data-seo-path="${escapeHtml(m.path)}">`);
  html = html.replace(/<title>[\s\S]*?<\/title>\s*/i, "");
  if (m.favicon) html = html.replace(/<link rel="icon" href="data:,"\s*\/?>\s*/i, "");
  const tags = renderHeadTags(m);
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `    ${tags}\n  </head>`) : `${tags}\n${html}`;
}
