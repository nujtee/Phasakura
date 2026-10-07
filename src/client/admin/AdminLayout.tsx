import { useEffect, useState, type ReactNode } from "react";
import { LOCALES } from "../../shared/i18n/locales.ts";
import { adminPath, pagePath } from "../../shared/routes.ts";
import { Link, useRouter } from "../router/Router.tsx";
import { useAdmin } from "./AdminContext.tsx";
import { ADMIN_NAV } from "./nav.ts";

export function AdminLayout({ currentPath, children }: { currentPath: string; children: ReactNode }) {
  const { t, me, can, href, logout, locale } = useAdmin();
  const { pathname } = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Same admin page in another language.
  const rest = pathname.split("/").slice(3);

  return (
    <div className="adm-shell">
      <a className="skip-link" href="#adm-main">{t.nav.adminNavigation}</a>
      <header className="adm-topbar">
        <button
          type="button"
          className="adm-topbar__menu"
          aria-expanded={open}
          aria-controls="adm-sidebar"
          aria-label={open ? t.nav.closeMenu : t.nav.openMenu}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <Link to={href()} className="adm-topbar__title">Admin</Link>
        <nav className="adm-topbar__langs" aria-label={t.common.language}>
          {LOCALES.map((l) => (
            <Link
              key={l.code}
              to={`${adminPath(l)}${rest.length ? `/${rest.join("/")}` : ""}`}
              lang={l.code}
              aria-current={l.code === locale.code ? "true" : undefined}
            >
              {l.shortLabel}
            </Link>
          ))}
        </nav>
        <div className="adm-topbar__user">
          <span className="adm-topbar__name">{me?.displayName}</span>
          <Link to={href("change-password")} className="adm-topbar__link">{t.nav.changePassword}</Link>
          <button type="button" className="adm-topbar__link" onClick={() => void logout()}>{t.auth.logout}</button>
        </div>
      </header>

      <aside id="adm-sidebar" className={`adm-sidebar ${open ? "adm-sidebar--open" : ""}`}>
        <nav aria-label={t.nav.adminNavigation}>
          {ADMIN_NAV.map((group, gi) => {
            const items = group.items.filter((item) => can(item.permission));
            if (items.length === 0) return null;
            return (
              <div key={gi} className="adm-nav__group">
                {group.label && <p className="adm-nav__heading">{group.label(t)}</p>}
                <ul>
                  {items.map((item) => (
                    <li key={item.path}>
                      <Link
                        to={href(...(item.path ? [item.path] : []))}
                        className={`adm-nav__link ${item.ready ? "" : "adm-nav__link--soon"}`}
                        aria-current={currentPath === item.path ? "page" : undefined}
                      >
                        {item.label(t)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="adm-nav__group">
            <a className="adm-nav__link" href={pagePath(locale, "home")} target="_blank" rel="noopener">{t.nav.viewSite} ↗</a>
          </div>
        </nav>
        {/* Mobile only: account actions + language (the top bar is too narrow). */}
        <div className="adm-sidebar__account">
          <p className="adm-nav__heading">{me?.displayName}</p>
          <nav className="adm-sidebar__langs" aria-label={t.common.language}>
            {LOCALES.map((l) => (
              <Link key={l.code} to={`${adminPath(l)}${rest.length ? `/${rest.join("/")}` : ""}`} lang={l.code}
                aria-current={l.code === locale.code ? "true" : undefined}>
                {l.shortLabel}
              </Link>
            ))}
          </nav>
          <Link to={href("change-password")} className="adm-nav__link">{t.nav.changePassword}</Link>
          <button type="button" className="adm-nav__link adm-nav__button" onClick={() => void logout()}>{t.auth.logout}</button>
        </div>
      </aside>
      {open && <div className="adm-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}

      <main id="adm-main" className="adm-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
