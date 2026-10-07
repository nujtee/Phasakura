import { useEffect, useState, type CSSProperties } from "react";
import type { SitePage } from "../../shared/routes.ts";
import type { BookingCtaDto } from "../../shared/settings-types.ts";
import { pagePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";

type CtaConfig = Omit<BookingCtaDto, "labels"> & { label: string | null };

const DISMISS_KEY = "phasakura.cta.dismissed";

function Icon({ name }: { name: CtaConfig["icon"] }) {
  if (name === "none") return null;
  const paths: Record<Exclude<CtaConfig["icon"], "none">, string> = {
    calendar: "M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    bed: "M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11.5a1.5 1.5 0 1 0 0-.01",
    tent: "M12 4 3 20h18L12 4zM12 4v16M9 20l3-6 3 6",
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
  };
  return (
    <svg className="cta__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The button itself (also used as a live preview in the admin). */
export function CtaButton({ config, href, preview, onClose, closeLabel }: {
  config: CtaConfig; href: string; preview?: boolean; onClose?: () => void; closeLabel?: string;
}) {
  const classes = [
    "cta", `cta--${config.size.toLowerCase()}`, `cta--anim-${config.animation.toLowerCase()}`,
    `cta--d-${config.desktopPosition.toLowerCase()}`, `cta--m-${config.mobilePosition.toLowerCase()}`,
    config.showOnDesktop ? "" : "cta--hide-d", config.showOnMobile ? "" : "cta--hide-m", preview ? "cta--preview" : "",
  ].filter(Boolean).join(" ");
  // Colour is validated as #RRGGBB on the server and again here; set through CSSOM (CSP-safe).
  const style = config.color && /^#[0-9A-Fa-f]{6}$/.test(config.color) ? ({ "--cta-color": config.color } as CSSProperties) : undefined;
  const content = <><Icon name={config.icon} /><span>{config.label}</span></>;
  return (
    <div className={classes} style={style}>
      {preview ? <span className="cta__button">{content}</span> : <Link to={href} className="cta__button">{content}</Link>}
      {config.closeable && onClose && (
        <button type="button" className="cta__close" aria-label={closeLabel} onClick={onClose}>×</button>
      )}
    </div>
  );
}

/**
 * Floating booking button (spec §39). Configured in D1 (Settings → Booking CTA).
 * Never shown on the booking pages themselves, so it can't cover the booking form.
 */
export function FloatingBookingCta({ page }: { page: SitePage | null }) {
  const { site } = useSite();
  const { locale, t } = useI18n();
  const [dismissed, setDismissed] = useState(false);
  const cta = site?.bookingCta ?? null;

  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const pageKey = page === "bookingLookup" ? "booking" : page;
  const visible = !!cta && !!cta.label && !dismissed && page !== null && pageKey !== "booking"
    && (cta.pages.includes("*") || cta.pages.includes(pageKey as never));

  // Reserve space at the bottom of the page for a full-width bar so it never hides the footer.
  // …and tell other floating buttons (LINE) where the CTA sits so they stack above it.
  useEffect(() => {
    const root = document.documentElement.classList;
    const bar = visible && cta?.showOnMobile && cta.mobilePosition === "BOTTOM_BAR";
    root.toggle("has-cta-bar", !!bar);
    root.toggle("has-cta-m-right", !!(visible && cta?.showOnMobile && cta.mobilePosition === "BOTTOM_RIGHT"));
    root.toggle("has-cta-d-right", !!(visible && cta?.showOnDesktop && cta.desktopPosition === "BOTTOM_RIGHT"));
    return () => root.remove("has-cta-bar", "has-cta-m-right", "has-cta-d-right");
  }, [visible, cta]);

  if (!visible || !cta) return null;
  return (
    <CtaButton config={cta} href={pagePath(locale, "booking")} closeLabel={t.common.close}
      onClose={() => {
        setDismissed(true);
        try {
          window.sessionStorage.setItem(DISMISS_KEY, "1");
        } catch {
          // storage unavailable: hidden for this page view only
        }
      }} />
  );
}
