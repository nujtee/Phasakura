import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { PublicSlideDto } from "../../src/shared/content-types.ts";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import { HeroSlideshow } from "../../src/client/content/HeroSlideshow.tsx";
import { Lightbox } from "../../src/client/content/Lightbox.tsx";
import { ResponsiveImage } from "../../src/client/content/ResponsiveImage.tsx";
import { SmartLink } from "../../src/client/content/SmartLink.tsx";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { RouterProvider } from "../../src/client/router/Router.tsx";
import { loadFonts } from "../../src/client/site/SiteProvider.tsx";

function render(node: ReactNode, lang: LocaleCode = "th") {
  const locale = getLocale(lang);
  return renderToStaticMarkup(
    <RouterProvider initialPath={`/${locale.path}/`}>
      <I18nProvider locale={locale}>{node}</I18nProvider>
    </RouterProvider>,
  );
}

const img = (url: string, srcset: string | null = null) => ({ url, srcset, alt: `alt ${url}`, width: 2400, height: 1600 });

function slide(id: string, extra: Partial<PublicSlideDto> = {}): PublicSlideDto {
  return {
    id, desktop: img(`/media/home/slides/${id}.webp`, `/media/home/slides/${id}-w640.webp 640w, /media/home/slides/${id}.webp 2400w`),
    mobile: null, overlay: { enabled: true, color: "#102030", opacity: 40 }, position: "BOTTOM_LEFT",
    title: null, subtitle: null, description: null, button1: null, button2: null, ...extra,
  };
}

describe("ResponsiveImage", () => {
  it("adds srcset + sizes only when renditions exist, reserves space and lazy-loads by default", () => {
    const html = renderToStaticMarkup(<ResponsiveImage image={img("/media/a.webp", "/media/a-w480.webp 480w, /media/a.webp 2400w")} sizes="50vw" />);
    assert.match(html, /srcSet="\/media\/a-w480\.webp 480w, \/media\/a\.webp 2400w"/);
    assert.match(html, /sizes="50vw"/);
    assert.match(html, /width="2400" height="1600"/);
    assert.match(html, /loading="lazy"/);
    assert.doesNotMatch(html, /fetchPriority/i);
    const plain = renderToStaticMarkup(<ResponsiveImage image={img("/media/b.png")} sizes="50vw" priority alt="" />);
    assert.doesNotMatch(plain, /srcSet|sizes=/, "no renditions: plain src");
    assert.match(plain, /loading="eager"/);
    assert.match(plain, /fetchPriority="high"/);
    assert.match(plain, /alt=""/, "decorative override");
  });
});

describe("SmartLink", () => {
  it("routes /paths in-app, opens https links in a new tab, never renders other schemes as links", () => {
    assert.match(render(<SmartLink href="/th/booking">Book</SmartLink>), /^<a href="\/th\/booking">Book<\/a>$/);
    const ext = render(<SmartLink href="https://maps.example.com/x">Map</SmartLink>);
    assert.match(ext, /target="_blank"/);
    assert.match(ext, /rel="noopener noreferrer"/);
    for (const bad of ["javascript:alert(1)", "//evil.example.com", "http://plain.example.com", "data:text/html,x"]) {
      assert.equal(render(<SmartLink href={bad}>X</SmartLink>), "<span>X</span>", bad);
    }
  });
});

describe("HeroSlideshow", () => {
  it("renders an accessible carousel: hidden page title, first image eager, later slides deferred", () => {
    const html = render(<HeroSlideshow title="Phasakura" slides={[
      slide("s1", { title: "Mountain mornings", button1: { label: "Book", url: "/th/booking" } }), slide("s2"), slide("s3"),
    ]} />);
    assert.match(html, /<h1 class="visually-hidden">Phasakura<\/h1>/);
    assert.match(html, /aria-roledescription="carousel"/);
    assert.match(html, /<h2 class="hero__title">Mountain mornings<\/h2>/);
    assert.equal((html.match(/<img /g) ?? []).length, 2, "the current and the next slide only");
    assert.match(html, /<img src="\/media\/home\/slides\/s1\.webp"[^>]*loading="eager"[^>]*fetchPriority="high"/);
    assert.match(html, /s2\.webp"[^>]*loading="lazy"/);
    assert.match(html, /--hero-overlay:#102030;--hero-overlay-opacity:0\.4/);
    assert.match(html, /hero__content--bottom_left/);
    assert.equal((html.match(/class="hero__dot"/g) ?? []).length, 3);
    assert.match(html, /aria-label="ไปยังภาพที่ 1" aria-current="true"/);
    assert.match(html, /aria-label="หยุดเลื่อนอัตโนมัติ"/, "autoplay on: the button pauses");
    assert.match(html, /aria-hidden="true"[^>]*>/, "inactive slides are hidden from assistive tech");
  });

  it("uses the mobile image below 768px and shows no controls for a single slide", () => {
    const html = render(<HeroSlideshow title="X" slides={[slide("only", { mobile: img("/media/m.webp") })]} />, "en");
    assert.match(html, /<source media="\(max-width: 767px\)" srcSet="\/media\/m\.webp"/);
    assert.doesNotMatch(html, /hero__controls/);
    assert.equal(render(<HeroSlideshow title="X" slides={[]} />), "");
  });
});

describe("Lightbox", () => {
  it("renders an empty closed dialog until a photo is opened", () => {
    const items = [{ id: "a", image: img("/media/a.webp"), title: "A", caption: "Sunrise" }];
    assert.match(render(<Lightbox items={items} index={null} onIndex={() => {}} onClose={() => {}} />), /^<dialog class="lightbox" aria-label="ดูภาพขนาดใหญ่"><\/dialog>$/);
    const open = render(<Lightbox items={items} index={0} onIndex={() => {}} onClose={() => {}} />, "zh-CN");
    assert.match(open, /<figcaption class="lightbox__caption"><strong>A<\/strong><span>Sunrise<\/span><\/figcaption>/);
    assert.doesNotMatch(open, /lightbox__nav/, "no arrows for a single photo");
  });
});

describe("loadFonts", () => {
  it("registers same-origin or https faces with the FontFace API and removes them on cleanup", () => {
    const created: { family: string; source: string; descriptors: Record<string, string> }[] = [];
    const g = globalThis as { FontFace?: unknown };
    const previous = g.FontFace;
    g.FontFace = class {
      constructor(family: string, source: string, descriptors: Record<string, string>) {
        if (/bad/.test(family)) throw new SyntaxError("bad");
        created.push({ family, source, descriptors });
      }
    };
    const set = new Set<unknown>();
    const fontSet = { add: (f: unknown) => set.add(f), delete: (f: unknown) => set.delete(f) } as unknown as FontFaceSet;
    try {
      const cleanup = loadFonts([
        { family: "Brand", url: "/media/fonts/a.woff2", weight: 700, style: "normal", format: "woff2" },
        { family: "Brand", url: "https://media.example.com/fonts/b.woff", weight: 400, style: "italic", format: "woff" },
        { family: "Evil", url: "javascript:alert(1)", weight: 400, style: "normal", format: "woff2" },
        { family: "bad", url: "/media/fonts/c.woff2", weight: 400, style: "normal", format: "woff2" },
      ], fontSet);
      assert.deepEqual(created.map((c) => c.source), ['url("/media/fonts/a.woff2") format("woff2")', 'url("https://media.example.com/fonts/b.woff") format("woff")']);
      assert.deepEqual(created[0]!.descriptors, { weight: "700", style: "normal", display: "swap" });
      assert.equal(set.size, 2);
      cleanup();
      assert.equal(set.size, 0);
      assert.equal(typeof loadFonts([], fontSet), "function");
    } finally {
      g.FontFace = previous;
    }
  });
});
