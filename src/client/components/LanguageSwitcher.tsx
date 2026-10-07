import { LOCALES } from "../../shared/i18n/index.ts";
import { switchLocalePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link, useRouter } from "../router/Router.tsx";

/**
 * Links to the same page in every language. Plain links (not a JS dropdown) so it
 * works for keyboard, screen readers and crawlers.
 */
export function LanguageSwitcher({
  className,
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
}) {
  const { locale: current, t } = useI18n();
  const { pathname } = useRouter();
  return (
    <nav className={["lang-switcher", className].filter(Boolean).join(" ")} aria-label={t.header.languageSwitcher}>
      <ul>
        {LOCALES.map((locale) => {
          const isCurrent = locale.code === current.code;
          return (
            <li key={locale.code}>
              <Link
                to={switchLocalePath(pathname, locale)}
                lang={locale.code}
                hrefLang={locale.code}
                aria-current={isCurrent ? "true" : undefined}
                className="lang-switcher__link"
                onClick={onNavigate}
              >
                <span aria-hidden="true">{locale.shortLabel}</span>
                <span className="visually-hidden">{locale.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
