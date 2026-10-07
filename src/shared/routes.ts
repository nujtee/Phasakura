/**
 * Public site routes. The slug list is routing configuration shared by the
 * client router, sitemap (Phase 13) and tests.
 */
import { DEFAULT_LOCALE, LOCALES, localeFromPath, type Locale } from "./i18n/locales.ts";

export const PUBLIC_PAGES = ["home", "gallery", "booking", "history"] as const;
export type PublicPage = (typeof PUBLIC_PAGES)[number];

const PAGE_SLUGS: Record<PublicPage, string> = {
  home: "",
  gallery: "gallery",
  booking: "booking",
  history: "history",
};

export function pagePath(locale: Locale, page: PublicPage): string {
  const slug = PAGE_SLUGS[page];
  return slug ? `/${locale.path}/${slug}` : `/${locale.path}/`;
}

/** Pages that exist but are not in the main menu. */
export type SitePage = PublicPage | "accommodation" | "bookingLookup";

/** Guest booking lookup (Booking ID + phone). */
export function bookingLookupPath(locale: Locale): string {
  return `/${locale.path}/booking/lookup`;
}

const DETAIL_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export function accommodationPath(locale: Locale, slug: string): string {
  return `/${locale.path}/accommodation/${encodeURIComponent(slug)}`;
}

/** The same path in another language: swaps the first (locale) segment. */
export function switchLocalePath(pathname: string, target: Locale): string {
  const segments = pathname.split("/");
  if (segments.length > 1 && localeFromPath(segments[1])) segments[1] = target.path;
  else return pagePath(target, "home");
  return segments.join("/") || "/";
}

export type ResolvedRoute =
  | { kind: "redirect"; to: string }
  | { kind: "page"; locale: Locale; page: SitePage; slug?: string }
  | { kind: "admin"; locale: Locale; segments: string[] }
  | { kind: "notFound"; locale: Locale };

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Admin URL for a locale, e.g. adminPath(th, "users", id) → /th/admin/users/<id> */
export function adminPath(locale: Locale, ...segments: string[]): string {
  return `/${locale.path}/admin${segments.length ? `/${segments.map(encodeURIComponent).join("/")}` : ""}`;
}

/**
 * Pure route resolution: pathname -> what to render.
 * - "/"              → redirect to default locale home
 * - "/th"            → redirect to "/th/" (canonical trailing slash for locale home)
 * - "/EN/gallery"    → redirect to "/en/gallery" (canonical lowercase)
 * - "/th/gallery/"   → redirect to "/th/gallery" (no trailing slash on pages)
 * - "/admin/..."     → redirect to "/{default}/admin/..."
 * - "/th/admin/..."  → admin app (segments after "admin")
 * - unknown locale   → notFound in default locale
 */
export function resolveRoute(pathname: string): ResolvedRoute {
  const segments = pathname.split("/").filter((s) => s.length > 0);

  if (segments.length === 0) {
    return { kind: "redirect", to: pagePath(DEFAULT_LOCALE, "home") };
  }

  const [first, ...rest] = segments;

  if (first === "admin") {
    return { kind: "redirect", to: `/${DEFAULT_LOCALE.path}/${segments.join("/")}` };
  }

  const locale = localeFromPath(first);
  if (!locale) return { kind: "notFound", locale: DEFAULT_LOCALE };

  if (first !== locale.path) {
    const tail = rest.length ? `/${rest.join("/")}` : "/";
    return { kind: "redirect", to: `/${locale.path}${tail}` };
  }

  if (rest[0] === "admin") {
    const adminSegments = rest.slice(1);
    if (adminSegments.every((s) => SAFE_SEGMENT.test(s)) && adminSegments.length <= 4) {
      return { kind: "admin", locale, segments: adminSegments };
    }
    return { kind: "notFound", locale };
  }

  if (rest.length === 0) {
    if (!pathname.endsWith("/")) return { kind: "redirect", to: pagePath(locale, "home") };
    return { kind: "page", locale, page: "home" };
  }

  if (rest.length === 2 && rest[0] === "accommodation" && DETAIL_SLUG.test(rest[1]!)) {
    if (pathname.endsWith("/")) return { kind: "redirect", to: accommodationPath(locale, rest[1]!) };
    return { kind: "page", locale, page: "accommodation", slug: rest[1]! };
  }

  if (rest.length === 2 && rest[0] === "booking" && rest[1] === "lookup") {
    if (pathname.endsWith("/")) return { kind: "redirect", to: bookingLookupPath(locale) };
    return { kind: "page", locale, page: "bookingLookup" };
  }

  if (rest.length === 1) {
    const page = PUBLIC_PAGES.find((p) => PAGE_SLUGS[p] === rest[0]);
    if (page && page !== "home") {
      if (pathname.endsWith("/")) return { kind: "redirect", to: pagePath(locale, page) };
      return { kind: "page", locale, page };
    }
  }

  return { kind: "notFound", locale };
}

/** Same page in every locale — used by the language switcher and hreflang. */
export function alternatePaths(page: PublicPage): { locale: Locale; path: string }[] {
  return LOCALES.map((locale) => ({ locale, path: pagePath(locale, page) }));
}
