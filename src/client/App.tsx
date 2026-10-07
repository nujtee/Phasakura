import { useEffect, useLayoutEffect } from "react";
import { getMessages } from "../shared/i18n/index.ts";
import { resolveRoute, type PublicPage, type SitePage } from "../shared/routes.ts";
import { AdminApp } from "./admin/AdminApp.tsx";
import { Layout } from "./components/Layout.tsx";
import { I18nProvider } from "./i18n/I18nProvider.tsx";
import { AccommodationDetailPage } from "./pages/AccommodationDetailPage.tsx";
import { BookingLookupPage } from "./pages/BookingLookupPage.tsx";
import { BookingPage } from "./pages/BookingPage.tsx";
import { GalleryPage } from "./pages/GalleryPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { PrivacyPage } from "./pages/PrivacyPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { useRouter } from "./router/Router.tsx";
import { setTrackingSuspended } from "./analytics/tracker.ts";
import { SiteProvider } from "./site/SiteProvider.tsx";

export function App() {
  const { pathname, navigate } = useRouter();
  const route = resolveRoute(pathname);

  useEffect(() => {
    if (route.kind === "redirect") navigate(route.to, { replace: true });
  }, [route, navigate]);

  // Nothing is tracked in the back office. A layout effect runs before the pages' page-view effects.
  const isAdmin = route.kind === "admin";
  useLayoutEffect(() => setTrackingSuspended(isAdmin), [isAdmin]);

  if (route.kind === "redirect") return null;

  // Admin area: separate shell, no public header/footer.
  if (route.kind === "admin") return <AdminApp locale={route.locale} segments={route.segments} />;

  const t = getMessages(route.locale.code);
  const page: SitePage | null = route.kind === "page" ? route.page : null;
  const slug = route.kind === "page" ? route.slug : undefined;
  // Accommodation details live under the Booking section of the menu.
  const navPage: PublicPage | null = page === "accommodation" || page === "bookingLookup" ? "booking" : page === "privacy" ? null : page;
  const title = page ? t.pages[page].title : t.pages.notFound.title;

  return (
    <I18nProvider locale={route.locale}>
      <SiteProvider locale={route.locale}>
        <Layout currentPage={navPage} sitePage={page} title={title}>
          {renderPage(page, title, slug)}
        </Layout>
      </SiteProvider>
    </I18nProvider>
  );
}

function renderPage(page: SitePage | null, title: string, slug: string | undefined) {
  switch (page) {
    case "home":
      return <HomePage />;
    case "booking":
      return <BookingPage />;
    case "bookingLookup":
      return <BookingLookupPage />;
    case "accommodation":
      return slug ? <AccommodationDetailPage key={slug} slug={slug} /> : <NotFoundPage />;
    case "gallery":
      return <GalleryPage title={title} />;
    case "history":
      return <HistoryPage title={title} />;
    case "privacy":
      return <PrivacyPage title={title} />;
    default:
      return <NotFoundPage />;
  }
}
