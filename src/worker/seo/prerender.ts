import type { PublicAccommodationsDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import type { PublicSiteDto } from "../../shared/api-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import type { PublicGalleryDto, PublicHistoryDto, PublicHomeDto, PublicImageDto, PublicSectionDto } from "../../shared/content-types.ts";
import type { Messages } from "../../shared/i18n/messages.ts";
import { splitPhones } from "../../shared/phones.ts";
import type { PageMetaDto } from "../../shared/seo-types.ts";
import type { PublicPrivacyDto } from "../../shared/settings-types.ts";
import type { PublicSlideDto } from "../../shared/content-types.ts";
import { objectPosition, zoomScale, type FocalPoint } from "../../shared/focal-point.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { COLOR_TOKENS } from "../../shared/theme.ts";
import { escapeHtml, jsonForScript } from "./html.ts";

/**
 * Prerendered page content (Rendering: SSR / prerender). The Worker puts the page's real content — heading,
 * text, links to every house, photos with alt text, contact details — into <div id="root"> as plain semantic
 * HTML, so search engines, link previews and AI crawlers read the page without running JavaScript. The app
 * replaces it as soon as it starts (createRoot clears the container), so visitors see the normal site.
 * Only public, indexable pages; the same published data the app shows (nothing hidden from people).
 */
export type PrerenderPage =
  | { kind: "home"; home: PublicHomeDto; stays: PublicAccommodationsDto }
  | { kind: "booking"; stays: PublicAccommodationsDto }
  | { kind: "accommodation"; unit: PublicUnitDto; bookingUrl: string }
  | { kind: "gallery"; gallery: PublicGalleryDto }
  | { kind: "history"; history: PublicHistoryDto }
  | { kind: "privacy"; policy: PublicPrivacyDto };

export interface PrerenderInput {
  meta: PageMetaDto;
  site: PublicSiteDto;
  t: Messages;
  nav: { home: string; gallery: string; booking: string; history: string };
  /** Paths of the main pages in this language. */
  paths: { home: string; gallery: string; booking: string; history: string };
  /** Path of an accommodation page in this language. */
  unitPath: (slug: string) => string;
  page: PrerenderPage;
}

const GALLERY_MAX = 40;
const UNIT_IMAGES_MAX = 8;

const e = escapeHtml;

function paragraphs(text: string | null | undefined): string {
  if (!text?.trim()) return "";
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${e(p).replace(/\n/g, "<br>")}</p>`).join("");
}

function img(i: PublicImageDto | null | undefined, opts: { sizes: string; eager?: boolean; alt?: string }): string {
  if (!i) return "";
  const attrs = [
    `src="${e(i.url)}"`,
    i.srcset ? `srcset="${e(i.srcset)}" sizes="${e(opts.sizes)}"` : "",
    `alt="${e(opts.alt ?? i.alt ?? "")}"`,
    i.width ? `width="${i.width}"` : "",
    i.height ? `height="${i.height}"` : "",
    opts.eager ? 'fetchpriority="high"' : 'loading="lazy"',
    'decoding="async"',
  ].filter(Boolean);
  return `<img ${attrs.join(" ")}>`;
}

function section(s: PublicSectionDto): string {
  if (!s.title && !s.body && !s.subtitle) return "";
  return `<section>${s.title ? `<h2>${e(s.title)}</h2>` : ""}${s.subtitle ? `<p>${e(s.subtitle)}</p>` : ""}${paragraphs(s.body)}`
    + `${s.image ? img(s.image, { sizes: "(min-width: 768px) 50vw, 100vw" }) : ""}`
    + `${s.button ? `<p><a href="${e(s.button.url)}">${e(s.button.label)}</a></p>` : ""}</section>`;
}

function unitList(stays: PublicAccommodationsDto, input: PrerenderInput): string {
  const { t, meta } = input;
  const price = (satang: number, per: string) => (satang > 0 ? ` · ${e(formatBaht(satang, meta.lang))} ${e(per)}` : "");
  const items = (units: PublicUnitDto[]) => units.map((u) =>
    `<li><a href="${e(input.unitPath(u.slug))}">${e(u.name)}</a>${price(u.priceSatang, t.accommodation.perNight)}`
    + ` · ${e(t.accommodation.upToGuests.replace("{n}", String(u.maxGuests)))}`
    + `${u.shortDescription ? `<br>${e(u.shortDescription)}` : ""}</li>`).join("");
  const parts: string[] = [];
  if (stays.houses.length) parts.push(`<h2>${e(t.accommodation.houses)}</h2><ul>${items(stays.houses)}</ul>`);
  if (stays.vipTents.length) parts.push(`<h2>${e(t.accommodation.vipTents)}</h2><ul>${items(stays.vipTents)}</ul>`);
  if (stays.camping.enabled) {
    parts.push(`<h2>${e(stays.camping.name ?? t.accommodation.camping)}</h2>${paragraphs(stays.camping.description)}`
      + (stays.camping.pricePerAdultNightSatang > 0
        ? `<p>${e(formatBaht(stays.camping.pricePerAdultNightSatang, meta.lang))} ${e(t.accommodation.perAdultPerNight)}</p>` : ""));
  }
  return parts.join("");
}

function main(input: PrerenderInput): string {
  const { page, meta, site, t } = input;
  switch (page.kind) {
    case "home": {
      const slide = page.home.slides[0];
      return `<h1>${e(site.siteName ?? meta.title)}</h1>${site.tagline ? `<p>${e(site.tagline)}</p>` : ""}`
        // Same picture element as the app's slideshow: phones download the phone photo, early (found in the HTML).
        + (slide ? `<picture>${slide.mobile ? `<source media="(max-width: 767px)" srcset="${e(slide.mobile.srcset ?? slide.mobile.url)}" sizes="100vw">` : ""}${img(slide.desktop, { sizes: "100vw", eager: true })}</picture>` : "")
        + page.home.slides.filter((s) => s.title).map((s) => `<p><strong>${e(s.title!)}</strong>${s.description ? ` — ${e(s.description)}` : ""}</p>`).join("")
        + page.home.sections.map(section).join("")
        + `<section><h2><a href="${e(input.paths.booking)}">${e(input.nav.booking)}</a></h2>${unitList(page.stays, input)}</section>`;
    }
    case "booking":
      return `<h1>${e(pageHeading(meta, site))}</h1>${unitList(page.stays, input)}`;
    case "accommodation": {
      const u = page.unit;
      const photos: PublicImageDto[] = [u.cover, ...u.images].filter((x) => x !== null);
      const unique = photos.filter((p, i) => photos.findIndex((q) => q.url === p.url) === i).slice(0, UNIT_IMAGES_MAX);
      return `<h1>${e(u.name)}</h1>`
        + (u.priceSatang > 0 ? `<p>${e(formatBaht(u.priceSatang, meta.lang))} ${e(t.accommodation.perNight)} · ${e(t.accommodation.upToGuests.replace("{n}", String(u.maxGuests)))}</p>` : "")
        + (unique[0] ? img(unique[0], { sizes: "100vw", eager: true, alt: unique[0].alt || u.name }) : "")
        + (u.shortDescription ? `<p>${e(u.shortDescription)}</p>` : "")
        + paragraphs(u.description)
        + (u.amenities.length ? `<h2>${e(t.accommodation.amenities)}</h2><ul>${u.amenities.map((a) => `<li>${e(a.name)}</li>`).join("")}</ul>` : "")
        + (unique.length > 1 ? `<h2>${e(t.accommodation.photos)}</h2>${unique.slice(1).map((p) => img(p, { sizes: "(min-width: 768px) 33vw, 50vw", alt: p.alt || u.name })).join("")}` : "")
        + `<p><a href="${e(page.bookingUrl)}">${e(input.nav.booking)}</a></p>`;
    }
    case "gallery":
      return `<h1>${e(pageHeading(meta, site))}</h1><ul>${page.gallery.images.slice(0, GALLERY_MAX).map((g) =>
        `<li><figure>${img(g.image, { sizes: "(min-width: 1024px) 25vw, 50vw" })}${g.title || g.caption
          ? `<figcaption>${g.title ? e(g.title) : ""}${g.title && g.caption ? " — " : ""}${g.caption ? e(g.caption) : ""}</figcaption>` : ""}</figure></li>`).join("")}</ul>`;
    case "history":
      return `<h1>${e(pageHeading(meta, site))}</h1>${page.history.sections.map(section).join("")}`
        + (page.history.timeline.length
          ? `<ol>${page.history.timeline.map((i) => `<li><strong>${i.year}</strong> ${e(i.title)}${i.description ? ` — ${e(i.description)}` : ""}</li>`).join("")}</ol>` : "");
    case "privacy":
      return `<h1>${e(page.policy.title ?? pageHeading(meta, site))}</h1>${paragraphs(page.policy.body)}`;
  }
}

/** The page title without " | site name". */
function pageHeading(meta: PageMetaDto, site: PublicSiteDto): string {
  const suffix = site.siteName ? ` | ${site.siteName}` : "";
  return suffix && meta.title.endsWith(suffix) ? meta.title.slice(0, -suffix.length) : meta.title;
}

/** The prerendered content for <div id="root">. */
export function prerenderBody(input: PrerenderInput): string {
  const { meta, site, t, nav, paths } = input;
  const links = (["home", "gallery", "booking", "history"] as const)
    .map((k) => `<li><a href="${e(paths[k])}">${e(nav[k])}</a></li>`).join("");
  const languages = meta.alternates.filter((a) => a.hreflang !== "x-default" && a.hreflang.toLowerCase() !== meta.lang.toLowerCase())
    .map((a) => `<li><a href="${e(a.href)}" hreflang="${e(a.hreflang)}" lang="${e(a.hreflang)}">${e(a.hreflang.toUpperCase())}</a></li>`).join("");
  const c = site.contact;
  const contact = [
    c.address ? `<p>${e(c.address)}</p>` : "",
    c.phone ? `<p>${e(t.footer.phone)}: ${splitPhones(c.phone).map((p) => `<a href="tel:${e(p.replace(/[^\d+]/g, ""))}">${e(p)}</a>`).join(", ")}</p>` : "",
    c.email ? `<p>${e(t.footer.email)}: <a href="mailto:${e(c.email)}">${e(c.email)}</a></p>` : "",
    c.lineOaUrl ? `<p><a href="${e(c.lineOaUrl)}" rel="noopener">${e(t.footer.line)}</a></p>` : "",
    c.mapUrl ? `<p><a href="${e(c.mapUrl)}" rel="noopener">${e(t.footer.map)}</a></p>` : "",
  ].join("");
  return `<div class="prerender">`
    + `<header><a href="${e(paths.home)}">${e(site.siteName ?? "")}</a><nav aria-label="${e(t.header.mainNavigation)}"><ul>${links}</ul></nav>`
    + (languages ? `<ul aria-label="${e(t.footer.languages)}">${languages}</ul>` : "") + `</header>`
    + `<main>${main(input)}</main>`
    + (contact ? `<footer><h2>${e(t.footer.contact)}</h2>${contact}${site.footerText ? `<p>${e(site.footerText)}</p>` : ""}</footer>` : "")
    + `</div>`;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** A focal point as CSS custom properties; nothing unless every number is a plain number. */
function focalVars(focal: FocalPoint | null | undefined, suffix: string): string {
  if (!focal || !finite(focal.x) || !finite(focal.y) || (focal.zoom != null && !finite(focal.zoom))) return "";
  return `--hero-focal${suffix}:${objectPosition(focal)};--hero-zoom${suffix}:${zoomScale(focal)};`;
}

/**
 * The published theme's colours as a style sheet for <head>, so the page has them from its first paint (the app
 * sets the same values on <html> when it starts; a draft preview still wins, being set on the element itself).
 * Only six-digit hex colours are written: nothing an admin typed can end the rule.
 */
export function themeCss(site: PublicSiteDto): string {
  const tokens = (site.theme ?? {}) as Record<string, unknown>;
  const vars = COLOR_TOKENS.map((name) => {
    const value = tokens[name];
    return typeof value === "string" && HEX.test(value) ? `${name}:${value};` : "";
  }).join("");
  return vars ? `:root{${vars}}` : "";
}

/**
 * The first screen of the home page, visible before the app's script arrives: the header's bar (empty) and the
 * first slide's photo, in the app's own elements and classes so they sit exactly where the app draws them. The app
 * then replaces it with the same picture (already downloaded) plus the header, the texts and the controls.
 * Without this the screen stays blank until the script has run, however early the photo arrived.
 *
 * Not for the list layout (no hero) or a home page without slides. `css` carries the slide's tint and focal point
 * (custom properties only, numbers and hex colours) for the page's inline style sheet.
 */
export function heroShell(site: PublicSiteDto, slide: PublicSlideDto | undefined): { html: string; css: string } | null {
  if (!slide || site.layout === "LIST") return null;
  const tint = slide.overlay.enabled && HEX.test(slide.overlay.color) && finite(slide.overlay.opacity);
  const home = site.layout === "CLASSIC" ? "home" : `home home--${site.layout.toLowerCase()}`;
  const d = slide.desktop;
  const picture = `<picture class="hero__media">`
    + (slide.mobile ? `<source media="(max-width: 767px)" srcset="${e(slide.mobile.srcset ?? slide.mobile.url)}" sizes="${IMAGE_SIZES.hero}">` : "")
    + `<img src="${e(d.url)}"${d.srcset ? ` srcset="${e(d.srcset)}" sizes="${IMAGE_SIZES.hero}"` : ""} alt=""`
    + `${d.width ? ` width="${d.width}"` : ""}${d.height ? ` height="${d.height}"` : ""} fetchpriority="high" decoding="async"></picture>`;
  const html = `<div class="prerender-hero" aria-hidden="true">`
    + `<div class="site-header"><div class="container site-header__inner"></div></div>`
    + `<div class="site-main"><div class="${home}"><div class="hero"><div class="hero__viewport">`
    + `<div class="hero__slide is-active${tint ? " hero__slide--overlay" : ""}">${picture}</div>`
    + `</div></div></div></div></div>`;
  const css = (tint ? `.prerender-hero .hero__slide{--hero-overlay:${slide.overlay.color};--hero-overlay-opacity:${slide.overlay.opacity / 100};}` : "")
    + (() => {
      // As the app: a phone photo without a point of its own is centred, not cropped by the wide photo's point.
      const vars = focalVars(d.focal, "")
        + (slide.mobile ? focalVars(slide.mobile.focal, "-m") || "--hero-focal-m:50% 50%;--hero-zoom-m:1;" : "");
      return vars ? `.prerender-hero .hero__media{${vars}}` : "";
    })();
  return { html, css };
}

/** The id of the inline JSON block the app reads its first data from (src/client/api/boot.ts). */
export const BOOT_DATA_ID = "boot-data";

/**
 * Puts the prerendered content into the app shell's empty root element, followed by the page's data as inline JSON
 * (never run as script; `<` is escaped so content cannot close the element).
 */
export function injectBody(html: string, body: string, boot?: Record<string, unknown>): string {
  const data = boot && Object.keys(boot).length ? `<script type="application/json" id="${BOOT_DATA_ID}">${jsonForScript(boot)}</script>` : "";
  return html.replace(/<div id="root"><\/div>/, () => `<div id="root">${body}</div>${data}`);
}
