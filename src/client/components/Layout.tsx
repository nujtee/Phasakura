import { useEffect, useRef, type ReactNode } from "react";
import type { PublicPage, SitePage } from "../../shared/routes.ts";
import { FloatingBookingCta } from "./FloatingBookingCta.tsx";
import { LineButton } from "./LineButton.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useRouter } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { Footer } from "./Footer.tsx";
import { Header } from "./Header.tsx";
import { useHeadMeta } from "../seo/headMeta.ts";
import { track } from "../analytics/tracker.ts";
import { ConsentBannerSlot, ConsentProvider } from "../consent/ConsentProvider.tsx";

/** Which contact a link opens (for the Contact event); null = not a contact link. */
export function contactMethod(href: string): "phone" | "email" | "line" | "map" | null {
  const h = href.trim().toLowerCase();
  if (h.startsWith("tel:")) return "phone";
  if (h.startsWith("mailto:")) return "email";
  if (/^https:\/\/(line\.me|lin\.ee|page\.line\.me)\//.test(h)) return "line";
  if (/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/.test(h)) return "map";
  return null;
}

export function Layout({
  currentPage,
  sitePage = null,
  title,
  children,
}: {
  currentPage: PublicPage | null;
  /** Exact page (for the floating booking button's page list). */
  sitePage?: SitePage | null;
  title: string;
  children: ReactNode;
}) {
  const { locale, t } = useI18n();
  const { site, preview, exitPreview } = useSite();
  const { pathname } = useRouter();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // <html lang>; title, description, canonical, hreflang, Open Graph and JSON-LD follow the page (Phase 13).
  useEffect(() => {
    document.documentElement.lang = locale.code;
  }, [locale]);
  useHeadMeta(pathname, [title, site?.siteName].filter(Boolean).join(" | "));

  // One page view per address (cleaned of anything but campaign parameters); sent only with consent.
  useEffect(() => {
    track({ name: "page_view", location: window.location.href, title, language: locale.code });
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps -- once per page, not when the title loads

  // Phone / e-mail / LINE / map links anywhere on the public site count as "Contact".
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const method = a ? contactMethod(a.getAttribute("href") ?? "") : null;
      if (method) track({ name: "contact", method });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Move focus to main content after client-side navigation (screen reader announcement).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <ConsentProvider>
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {t.common.skipToContent}
      </a>
      <ConsentBannerSlot />
      {preview && (
        <div className="theme-preview-bar" role="status">
          <span>{t.common.themePreview}</span>
          <button type="button" onClick={exitPreview}>{t.common.exitPreview}</button>
        </div>
      )}
      <Header currentPage={currentPage} />
      <main id="main" ref={mainRef} tabIndex={-1} className="site-main">
        {children}
      </main>
      <Footer currentPage={currentPage} />
      <LineButton page={sitePage} />
      <FloatingBookingCta page={sitePage} />
    </div>
    </ConsentProvider>
  );
}
