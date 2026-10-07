import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocale } from "../../src/shared/i18n/index.ts";
import type { PageMetaDto } from "../../src/shared/seo-types.ts";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { RouterProvider } from "../../src/client/router/Router.tsx";
import { SearchDialog } from "../../src/client/search/SearchDialog.tsx";
import { applyHeadMeta, clearHeadMeta } from "../../src/client/seo/headMeta.ts";

/** Just enough DOM for the head manager. */
class FakeEl {
  attrs = new Map<string, string>();
  textContent = "";
  constructor(readonly tag: string, private readonly parent: FakeHead) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  remove() { this.parent.children = this.parent.children.filter((c) => c !== this); }
}
class FakeHead {
  children: FakeEl[] = [];
  querySelectorAll(sel: string) { return sel === "[data-seo]" ? this.children.filter((c) => c.attrs.has("data-seo")) : []; }
  appendChild(el: FakeEl) { this.children.push(el); }
}
function fakeDocument() {
  const head = new FakeHead();
  const doc = { head, title: "", documentElement: { dataset: {} as Record<string, string> }, createElement: (tag: string) => new FakeEl(tag, head) };
  return { doc: doc as unknown as Document, head, raw: doc };
}

const META: PageMetaDto = {
  path: "/en/gallery", status: 200, lang: "en", title: "Gallery | Site", description: "Photos", canonical: "https://x.test/en/gallery",
  robots: "index,follow", alternates: [{ hreflang: "th", href: "https://x.test/th/gallery" }, { hreflang: "x-default", href: "https://x.test/th/gallery" }],
  og: { type: "website", title: "Gallery", description: "Photos", url: "https://x.test/en/gallery", siteName: "Site", locale: "en_US", localeAlternates: ["th_TH"],
    image: { url: "https://x.test/media/a.webp", width: 1200, height: 630, alt: "A" } },
  jsonLd: [{ "@type": "BreadcrumbList", name: "</script>" }], googleSiteVerification: "abc", favicon: null,
};

describe("head manager (client navigation)", () => {
  it("replaces only data-seo tags, sets the title and marks the path", () => {
    const { doc, head, raw } = fakeDocument();
    const keep = new FakeEl("link", head);
    keep.setAttribute("rel", "icon");
    head.appendChild(keep);
    const old = new FakeEl("meta", head);
    old.setAttribute("data-seo", "");
    head.appendChild(old);
    applyHeadMeta(META, doc);
    assert.equal(raw.title, "Gallery | Site");
    assert.ok(!head.children.includes(old), "old page tags removed");
    assert.ok(head.children.includes(keep), "favicon kept");
    const find = (k: string, v: string) => head.children.filter((c) => c.attrs.get(k) === v);
    assert.equal(find("rel", "canonical")[0]!.attrs.get("href"), "https://x.test/en/gallery");
    assert.equal(find("rel", "alternate").length, 2);
    assert.equal(find("property", "og:image")[0]!.attrs.get("content"), "https://x.test/media/a.webp");
    assert.equal(find("name", "twitter:card")[0]!.attrs.get("content"), "summary_large_image");
    assert.equal(find("name", "google-site-verification")[0]!.attrs.get("content"), "abc");
    const ld = head.children.find((c) => c.tag === "script")!;
    assert.equal(ld.attrs.get("type"), "application/ld+json");
    assert.deepEqual(JSON.parse(ld.textContent), META.jsonLd[0], "data block via textContent");
    assert.equal(raw.documentElement.dataset.seoPath, "/en/gallery");
    clearHeadMeta(doc);
    assert.deepEqual(head.children, [keep]);
    assert.equal(raw.documentElement.dataset.seoPath, undefined);
  });
});

describe("search dialog", () => {
  it("renders a closed, labelled modal with the spec's placeholder and date fields", () => {
    const locale = getLocale("th");
    const html = renderToStaticMarkup(
      <RouterProvider initialPath="/th/">
        <I18nProvider locale={locale}><SearchDialog open={false} onClose={() => {}} /></I18nProvider>
      </RouterProvider>,
    );
    assert.match(html, /^<dialog class="search-dialog"/);
    assert.doesNotMatch(html, /<dialog[^>]*\sopen/, "closed until opened");
    assert.match(html, /role="search"/);
    assert.match(html, /placeholder="ค้นหาที่พัก อาหาร หรือกิจกรรม..."/);
    assert.equal((html.match(/type="date"/g) ?? []).length, 2);
    assert.match(html, /aria-label="ปิดการค้นหา"/);
  });
});
