import { useEffect, useId, useRef, useState } from "react";
import { pagePath, type PublicPage } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link, useRouter } from "../router/Router.tsx";
import { Brand } from "./Brand.tsx";
import { LanguageSwitcher } from "./LanguageSwitcher.tsx";
import { MAIN_MENU } from "./navigation.ts";
import { SearchDialog } from "../search/SearchDialog.tsx";
import { getSearchMessages } from "../../shared/i18n/search-messages.ts";

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
  const searchRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const sm = getSearchMessages(locale.code);

  // "/" opens the search from anywhere except while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(false);
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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

        <button ref={searchRef} type="button" className="search-toggle" aria-haspopup="dialog" aria-label={sm.open}
          onClick={() => { setOpen(false); setSearchOpen(true); }}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

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

      <SearchDialog open={searchOpen} onClose={() => { setSearchOpen(false); searchRef.current?.focus(); }} />
    </header>
  );
}
