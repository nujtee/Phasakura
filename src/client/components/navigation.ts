import type { Messages } from "../../shared/i18n/index.ts";
import type { PublicPage } from "../../shared/routes.ts";

/** Main menu order (spec §5/§7): Home, Gallery, Booking, History. */
export const MAIN_MENU: readonly { page: PublicPage; label: (t: Messages) => string }[] = [
  { page: "home", label: (t) => t.nav.home },
  { page: "gallery", label: (t) => t.nav.gallery },
  { page: "booking", label: (t) => t.nav.booking },
  { page: "history", label: (t) => t.nav.history },
];
