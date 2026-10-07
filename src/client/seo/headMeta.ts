import { useEffect } from "react";
import type { PageMetaDto } from "../../shared/seo-types.ts";
import { apiGet } from "../api/client.ts";

/**
 * Replaces the page's metadata tags (everything marked `data-seo`, rendered by the Worker on the
 * first request) with those of the page the visitor navigated to inside the app.
 */
export function applyHeadMeta(meta: PageMetaDto, doc: Document = document): void {
  const head = doc.head;
  head.querySelectorAll("[data-seo]").forEach((el) => el.remove());
  doc.title = meta.title;
  const add = (tag: "meta" | "link" | "script", attrs: Record<string, string>, text?: string) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.setAttribute("data-seo", "");
    if (text !== undefined) el.textContent = text;
    head.appendChild(el);
  };
  const meta2 = (attr: "name" | "property", key: string, content: string | null | undefined) => {
    if (content) add("meta", { [attr]: key, content });
  };
  meta2("name", "description", meta.description);
  meta2("name", "robots", meta.robots.replace(",", ", "));
  if (meta.canonical) add("link", { rel: "canonical", href: meta.canonical });
  for (const a of meta.alternates) add("link", { rel: "alternate", hreflang: a.hreflang, href: a.href });
  meta2("property", "og:type", meta.og.type);
  meta2("property", "og:site_name", meta.og.siteName);
  meta2("property", "og:title", meta.og.title);
  meta2("property", "og:description", meta.og.description);
  meta2("property", "og:url", meta.og.url);
  meta2("property", "og:locale", meta.og.locale);
  for (const l of meta.og.localeAlternates) meta2("property", "og:locale:alternate", l);
  if (meta.og.image) {
    meta2("property", "og:image", meta.og.image.url);
    if (meta.og.image.width) meta2("property", "og:image:width", String(meta.og.image.width));
    if (meta.og.image.height) meta2("property", "og:image:height", String(meta.og.image.height));
    meta2("property", "og:image:alt", meta.og.image.alt);
  }
  meta2("name", "twitter:card", meta.og.image ? "summary_large_image" : "summary");
  meta2("name", "twitter:title", meta.og.title);
  meta2("name", "twitter:description", meta.og.description);
  if (meta.og.image) meta2("name", "twitter:image", meta.og.image.url);
  meta2("name", "google-site-verification", meta.googleSiteVerification);
  // Data blocks (not executed): textContent, never innerHTML.
  for (const d of meta.jsonLd) add("script", { type: "application/ld+json" }, JSON.stringify(d));
  doc.documentElement.dataset.seoPath = meta.path;
}

/**
 * Keeps <head> in step with in-app navigation. The first page already has its metadata from the
 * Worker (`<html data-seo-path>`), so nothing is fetched for it. Meanwhile a provisional title is
 * shown; an answer for a page the visitor already left is ignored.
 */
export function useHeadMeta(pathname: string, provisionalTitle: string): void {
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.seoPath === pathname) return;
    document.title = provisionalTitle;
    const controller = new AbortController();
    apiGet<PageMetaDto>(`/api/public/meta?path=${encodeURIComponent(pathname)}`, controller.signal)
      .then((meta) => { if (meta.path === pathname && !controller.signal.aborted) applyHeadMeta(meta); })
      .catch(() => { /* keep the provisional title */ });
    return () => controller.abort();
  }, [pathname, provisionalTitle]);
}

/** Admin area: no public metadata, never indexed. */
export function clearHeadMeta(doc: Document = document): void {
  doc.head.querySelectorAll("[data-seo]").forEach((el) => el.remove());
  delete doc.documentElement.dataset.seoPath;
}
