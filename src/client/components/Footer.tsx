import { pagePath, type PublicPage } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { LanguageSwitcher } from "./LanguageSwitcher.tsx";
import { MAIN_MENU } from "./navigation.ts";

/**
 * Footer. Name, tagline, contact details and footer text come from D1 (Settings → Website).
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
          {site?.footerText && <p className="site-footer__text">{site.footerText}</p>}
        </div>

        {site && (site.contact.phone || site.contact.email || site.contact.lineOaUrl || site.contact.address) && (
          <address className="site-footer__contact" aria-label={t.footer.contact}>
            <p className="site-footer__heading">{t.footer.contact}</p>
            {site.contact.address && <p>{site.contact.address}</p>}
            {site.contact.phone && <p>{t.footer.phone}: <a href={`tel:${site.contact.phone.replace(/[^\d+]/g, "")}`}>{site.contact.phone}</a></p>}
            {site.contact.email && <p>{t.footer.email}: <a href={`mailto:${site.contact.email}`}>{site.contact.email}</a></p>}
            {site.contact.lineOaUrl && <p><a href={site.contact.lineOaUrl} rel="noopener noreferrer" target="_blank">{t.footer.line}</a></p>}
            {site.contact.mapUrl && <p><a href={site.contact.mapUrl} rel="noopener noreferrer" target="_blank">{t.footer.map}</a></p>}
          </address>
        )}

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
