import { EmptyState } from "../components/EmptyState.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useSite } from "../site/SiteProvider.tsx";

/**
 * Home. Sections (Hero slideshow, highlights, gallery/history/food previews,
 * location, contact) are CMS content from D1/R2 — built in later phases.
 */
export function HomePage() {
  const { t } = useI18n();
  const { site } = useSite();
  return (
    <section className="page container" aria-labelledby="page-title">
      <h1 id="page-title" className="page__title">
        {site?.siteName ?? t.pages.home.title}
      </h1>
      {site?.tagline && <p className="page__lead">{site.tagline}</p>}
      <EmptyState />
    </section>
  );
}
