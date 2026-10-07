import { pagePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";

/**
 * Logo from D1/R2 (never hard-coded). Mobile logo is used below 768px when set.
 * Falls back to the site name, then to a neutral placeholder while unconfigured.
 */
export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  const { locale, t } = useI18n();
  const { site } = useSite();
  const main = site?.logo.main ?? null;
  const mobile = site?.logo.mobile ?? null;
  const name = site?.siteName ?? null;

  let content;
  if (main) {
    content = (
      <picture>
        {mobile && <source media="(max-width: 767px)" srcSet={mobile.url} />}
        <img
          className="brand__logo"
          src={main.url}
          alt={name ?? ""}
          width={main.width ?? undefined}
          height={main.height ?? undefined}
          decoding="async"
          fetchPriority="high"
        />
      </picture>
    );
  } else if (name) {
    content = <span className="brand__name">{name}</span>;
  } else {
    content = <span className="brand__placeholder" aria-hidden="true" />;
  }

  return (
    <Link
      to={pagePath(locale, "home")}
      className="brand"
      aria-label={name ? undefined : t.header.homeLink}
      onClick={onNavigate}
    >
      {content}
    </Link>
  );
}
