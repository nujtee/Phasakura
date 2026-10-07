import { useEffect, useRef, type ReactNode } from "react";
import type { PublicPage } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useRouter } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { Footer } from "./Footer.tsx";
import { Header } from "./Header.tsx";

export function Layout({
  currentPage,
  title,
  children,
}: {
  currentPage: PublicPage | null;
  title: string;
  children: ReactNode;
}) {
  const { locale, t } = useI18n();
  const { site } = useSite();
  const { pathname } = useRouter();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // <html lang> and <title>. Full SEO metadata arrives in Phase 13.
  useEffect(() => {
    document.documentElement.lang = locale.code;
    document.title = [title, site?.siteName].filter(Boolean).join(" | ");
  }, [locale, title, site?.siteName]);

  // Move focus to main content after client-side navigation (screen reader announcement).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {t.common.skipToContent}
      </a>
      <Header currentPage={currentPage} />
      <main id="main" ref={mainRef} tabIndex={-1} className="site-main">
        {children}
      </main>
      <Footer currentPage={currentPage} />
    </div>
  );
}
