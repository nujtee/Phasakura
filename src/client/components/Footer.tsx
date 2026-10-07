import { pagePath, type PublicPage } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { LanguageSwitcher } from "./LanguageSwitcher.tsx";
import { MAIN_MENU } from "./navigation.ts";

/**
 * Footer. Contact / location / social blocks are content from D1 (Home CMS, Phase 9).
 */
export function Footer({ currentPage }: { currentPage: PublicPage | null }) {
  const { locale, t } = useI18n();
  const { site } = useSite();
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <div className="site-footer__brand">
          {site?.siteName && <p className="site-footer__name">{site.siteName}</p>}
          {site?.tagline && <p className="site-footer__tagline">{site.tagline}</p>}
        </div>

        <nav className="site-footer__nav" aria-label={t.footer.navigation}>
          <ul>
            {MAIN_MENU.map(({ page, label }) => (
              <li key={page}>
                <Link to={pagePath(locale, page)} aria-current={currentPage === page ? "page" : undefined}>
                  {label(t)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <LanguageSwitcher className="lang-switcher--footer" />
      </div>

      <div className="container site-footer__legal">
        <small>
          © {year}
          {site?.siteName ? ` ${site.siteName}` : ""} · {t.footer.rights}
        </small>
      </div>
    </footer>
  );
}
