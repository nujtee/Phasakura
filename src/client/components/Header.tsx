import { useEffect, useId, useRef, useState } from "react";
import { pagePath, type PublicPage } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link, useRouter } from "../router/Router.tsx";
import { Brand } from "./Brand.tsx";
import { LanguageSwitcher } from "./LanguageSwitcher.tsx";
import { MAIN_MENU } from "./navigation.ts";

/**
 * Desktop: Logo · Home · Gallery · Booking · History · Language
 * Mobile : Logo · Hamburger (menu panel with the same links + language)
 */
export function Header({ currentPage }: { currentPage: PublicPage | null }) {
  const { locale, t } = useI18n();
  const { pathname } = useRouter();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close the menu whenever the route changes.
  useEffect(() => setOpen(false), [pathname]);

  // While open: Escape closes and returns focus; focus moves into the panel.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  const links = (onNavigate?: () => void) =>
    MAIN_MENU.map(({ page, label }) => (
      <li key={page}>
        <Link
          to={pagePath(locale, page)}
          className="nav__link"
          aria-current={currentPage === page ? "page" : undefined}
          onClick={onNavigate}
        >
          {label(t)}
        </Link>
      </li>
    ));

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Brand onNavigate={close} />

        <nav className="nav nav--desktop" aria-label={t.header.mainNavigation}>
          <ul>{links()}</ul>
        </nav>

        <LanguageSwitcher className="lang-switcher--desktop" />

        <button
          ref={toggleRef}
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? t.header.closeMenu : t.header.openMenu}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>

      <div id={menuId} ref={panelRef} className="mobile-menu" hidden={!open}>
        <nav className="nav nav--mobile" aria-label={t.header.mainNavigation}>
          <ul>{links(close)}</ul>
        </nav>
        <LanguageSwitcher className="lang-switcher--mobile" onNavigate={close} />
      </div>
    </header>
  );
}
