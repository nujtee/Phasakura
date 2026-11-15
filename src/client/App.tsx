import { lazy, Suspense, useEffect, useLayoutEffect } from "react";
import { getMessages } from "../shared/i18n/index.ts";
import { resolveRoute, type SitePage } from "../shared/routes.ts";
import { Layout } from "./components/Layout.tsx";
import type { NavKey } from "./components/navigation.ts";
import { I18nProvider } from "./i18n/I18nProvider.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { useRouter } from "./router/Router.tsx";
import { setTrackingSuspended } from "./analytics/tracker.ts";
import { SiteProvider } from "./site/SiteProvider.tsx";

// The back office is a large part of the code and no visitor needs it: it is downloaded only when someone opens it.
const AdminApp = lazy(() => import("./admin/AdminApp.tsx").then((m) => ({ default: m.AdminApp })));

// Pages other than the home page come as their own files, so the first screen downloads less. The booking pages are
// fetched in the background once the first page is idle (PREFETCH), so going there does not wait.
const pages = {
  booking: () => import("./pages/BookingPage.tsx"),
  accommodation: () => import("./pages/AccommodationDetailPage.tsx"),
  bookingLookup: () => import("./pages/BookingLookupPage.tsx"),
  bookingMove: () => import("./pages/BookingMovePage.tsx"),
  gallery: () => import("./pages/GalleryPage.tsx"),
  history: () => import("./pages/HistoryPage.tsx"),
  privacy: () => import("./pages/PrivacyPage.tsx"),
};
const BookingPage = lazy(() => pages.booking().then((m) => ({ default: m.BookingPage })));
const AccommodationDetailPage = lazy(() => pages.accommodation().then((m) => ({ default: m.AccommodationDetailPage })));
const BookingLookupPage = lazy(() => pages.bookingLookup().then((m) => ({ default: m.BookingLookupPage })));
const BookingMovePage = lazy(() => pages.bookingMove().then((m) => ({ default: m.BookingMovePage })));
const GalleryPage = lazy(() => pages.gallery().then((m) => ({ default: m.GalleryPage })));
const HistoryPage = lazy(() => pages.history().then((m) => ({ default: m.HistoryPage })));
const PrivacyPage = lazy(() => pages.privacy().then((m) => ({ default: m.PrivacyPage })));

const PREFETCH = [pages.booking, pages.accommodation];
const PREFETCH_DELAY_MS = 2500;

export function App() {
  const { pathname, navigate } = useRouter();
  const route = resolveRoute(pathname);

  useEffect(() => {
    if (route.kind === "redirect") navigate(route.to, { replace: true });
  }, [route, navigate]);

  // Nothing is tracked in the back office. A layout effect runs before the pages' page-view effects.
  const isAdmin = route.kind === "admin";
  useLayoutEffect(() => setTrackingSuspended(isAdmin), [isAdmin]);

  // Once the first page has settled, fetch the booking pages so the next click is instant (public pages only).
  useEffect(() => {
    if (isAdmin) return;
    const timer = window.setTimeout(() => PREFETCH.forEach((load) => void load().catch(() => undefined)), PREFETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isAdmin]);

  if (route.kind === "redirect") return null;

  // Admin area: separate shell, no public header/footer.
  if (route.kind === "admin") {
    return (
      <Suspense fallback={<div className="app-loading" aria-busy="true" />}>
        <AdminApp locale={route.locale} segments={route.segments} />
      </Suspense>
    );
  }

  const t = getMessages(route.locale.code);
  const page: SitePage | null = route.kind === "page" ? route.page : null;
  const slug = route.kind === "page" ? route.slug : undefined;
  // Accommodation details live under the Booking section of the menu.
  const navPage: NavKey | null = page === "accommodation" ? "booking" : page === "privacy" ? null : page;
  const title = page ? t.pages[page].title : t.pages.notFound.title;

  return (
    <I18nProvider locale={route.locale}>
      <SiteProvider locale={route.locale}>
        <Layout currentPage={navPage} sitePage={page} title={title}>
          <Suspense fallback={<div className="page container page-loading" aria-busy="true" />}>
            {renderPage(page, title, slug)}
          </Suspense>
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
    case "bookingMove":
      return <BookingMovePage />;
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
