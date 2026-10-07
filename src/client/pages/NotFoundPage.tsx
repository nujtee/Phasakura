import { pagePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";

export function NotFoundPage() {
  const { locale, t } = useI18n();
  return (
    <section className="page container page--centered" aria-labelledby="page-title">
      <h1 id="page-title" className="page__title">
        {t.pages.notFound.title}
      </h1>
      <p className="page__lead">{t.pages.notFound.body}</p>
      <Link to={pagePath(locale, "home")} className="button button--primary">
        {t.pages.notFound.backHome}
      </Link>
    </section>
  );
}
