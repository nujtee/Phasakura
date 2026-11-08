import type { Messages } from "../../shared/i18n/index.ts";
import type { Locale } from "../../shared/i18n/locales.ts";
import { bookingLookupPath, bookingMovePath, pagePath, type PublicPage } from "../../shared/routes.ts";

/** A main-menu entry: a public page, or the guest booking look-up. */
export type NavKey = PublicPage | "bookingLookup" | "bookingMove";

/** Main menu order (spec §5/§7): Home, Gallery, Booking, History, then Check booking. */
export const MAIN_MENU: readonly { key: NavKey; href: (locale: Locale) => string; label: (t: Messages) => string }[] = [
  { key: "home", href: (l) => pagePath(l, "home"), label: (t) => t.nav.home },
  { key: "gallery", href: (l) => pagePath(l, "gallery"), label: (t) => t.nav.gallery },
  { key: "booking", href: (l) => pagePath(l, "booking"), label: (t) => t.nav.booking },
  { key: "history", href: (l) => pagePath(l, "history"), label: (t) => t.nav.history },
  { key: "bookingLookup", href: bookingLookupPath, label: (t) => t.nav.lookup },
  { key: "bookingMove", href: bookingMovePath, label: (t) => t.nav.move },
];
