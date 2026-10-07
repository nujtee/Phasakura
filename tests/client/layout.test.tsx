import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import type { PublicPage } from "../../src/shared/routes.ts";
import { Footer } from "../../src/client/components/Footer.tsx";
import { Header } from "../../src/client/components/Header.tsx";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { RouterProvider } from "../../src/client/router/Router.tsx";
import { SiteContext } from "../../src/client/site/SiteProvider.tsx";

function site(overrides: Partial<PublicSiteDto> = {}): PublicSiteDto {
  return {
    configured: true,
    language: "th",
    defaultLanguage: "th",
    languages: ["th", "en", "zh-CN"],
    siteName: "Site From D1",
    tagline: "Tagline From D1",
    logo: {
      main: { url: "/media/branding/main.webp", alt: "Site From D1", width: 240, height: 80 },
      mobile: { url: "/media/branding/mobile.webp", alt: "Site From D1", width: 80, height: 80 },
    },
    ...overrides,
  };
}

function render(
  node: "header" | "footer",
  opts: { lang?: LocaleCode; page?: PublicPage | null; site?: PublicSiteDto | null; path?: string } = {},
) {
  const locale = getLocale(opts.lang ?? "th");
  const page = opts.page === undefined ? "home" : opts.page;
  const value =
    opts.site === null
      ? { status: "loading" as const, site: null, retry: () => {} }
      : { status: "ready" as const, site: opts.site ?? site(), retry: () => {} };
  return renderToStaticMarkup(
    <RouterProvider initialPath={opts.path ?? `/${locale.path}/`}>
      <I18nProvider locale={locale}>
        <SiteContext.Provider value={value}>
          {node === "header" ? <Header currentPage={page} /> : <Footer currentPage={page} />}
        </SiteContext.Provider>
      </I18nProvider>
    </RouterProvider>,
  );
}

describe("Header", () => {
  it("renders the main menu in spec order with localized paths (TH)", () => {
    const html = render("header");
    const order = ["Home", "Gallery", "จองที่พัก", "ประวัติความเป็นมา"].map((label) => html.indexOf(`>${label}</a>`));
    assert.ok(order.every((i) => i > -1), "all menu labels present");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "menu order");
    for (const href of ["/th/", "/th/gallery", "/th/booking", "/th/history"]) {
      assert.ok(html.includes(`href="${href}"`), href);
    }
  });

  it("renders EN and ZH-CN labels and paths", () => {
    const enHtml = render("header", { lang: "en" });
    assert.ok(enHtml.includes('href="/en/booking"'));
    assert.ok(enHtml.includes(">Booking</a>"));
    const zhHtml = render("header", { lang: "zh-CN" });
    assert.ok(zhHtml.includes('href="/zh-cn/booking"'));
    assert.ok(zhHtml.includes(">立即预订</a>"));
  });

  it("marks the current page with aria-current", () => {
    const html = render("header", { page: "gallery" });
    assert.match(html, /href="\/th\/gallery"[^>]*aria-current="page"/);
  });

  it("uses the logo from the API (D1/R2) with a mobile source", () => {
    const html = render("header");
    assert.ok(html.includes('src="/media/branding/main.webp"'));
    assert.ok(html.includes('alt="Site From D1"'));
    assert.match(html, /<source media="\(max-width: 767px\)" srcSet="\/media\/branding\/mobile.webp"/i);
  });

  it("falls back to the site name when no logo is uploaded", () => {
    const html = render("header", { site: site({ logo: { main: null, mobile: null } }) });
    assert.ok(html.includes('class="brand__name">Site From D1<'));
  });

  it("shows a neutral placeholder (no hard-coded brand) while unconfigured", () => {
    const html = render("header", { site: null });
    assert.ok(html.includes("brand__placeholder"));
    assert.ok(html.includes('aria-label="กลับหน้าแรก"'), "home link still has an accessible name");
    assert.ok(!html.includes("<img"));
  });

  it("has an accessible hamburger button controlling a hidden menu", () => {
    const html = render("header");
    const button = /<button[^>]*class="menu-toggle"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(button, /aria-expanded="false"/);
    assert.match(button, /aria-label="เปิดเมนู"/);
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
    assert.ok(controls);
    assert.match(html, new RegExp(`<div id="${controls}"[^>]*hidden=""`));
  });

  it("language switcher keeps deep paths such as accommodation details", () => {
    const html = render("header", { page: "booking", lang: "th", path: "/th/accommodation/house-sakura" });
    assert.ok(html.includes('href="/zh-cn/accommodation/house-sakura"'));
    assert.ok(html.includes('href="/en/accommodation/house-sakura"'));
  });

  it("language switcher links to the same page in every language", () => {
    const html = render("header", { page: "history", lang: "en", path: "/en/history" });
    for (const [href, lang] of [
      ["/th/history", "th"],
      ["/en/history", "en"],
      ["/zh-cn/history", "zh-CN"],
    ]) {
      assert.match(html, new RegExp(`href="${href}"[^>]*lang="${lang}"[^>]*hrefLang="${lang}"`, "i"));
    }
    assert.match(html, /href="\/en\/history"[^>]*aria-current="true"/);
  });
});

describe("Footer", () => {
  it("renders site name and tagline from the API", () => {
    const html = render("footer");
    assert.ok(html.includes("Site From D1"));
    assert.ok(html.includes("Tagline From D1"));
    assert.ok(html.includes("สงวนลิขสิทธิ์"));
  });

  it("renders no brand text when unconfigured", () => {
    const html = render("footer", { site: null });
    assert.ok(!html.includes("site-footer__name"));
    assert.ok(html.includes('href="/th/gallery"'));
  });

  it("escapes content coming from the database (XSS)", () => {
    const html = render("footer", { site: site({ siteName: '<img src=x onerror="alert(1)">', tagline: null }) });
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img src=x"));
  });
});
