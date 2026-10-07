import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CONSENT_COOKIE, cookieValue, parseConsent, serializeConsent, type ConsentState } from "../../shared/consent.ts";
import { getConsentMessages } from "../../shared/i18n/consent-messages.ts";
import { configureTracking } from "../analytics/tracker.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { ConsentBanner } from "./ConsentBanner.tsx";
import { ConsentDialog } from "./ConsentDialog.tsx";

export interface ConsentContextValue {
  /** The visitor's choice for the current consent version, or null. */
  consent: ConsentState | null;
  /** Show "Cookie settings" in the footer (a tracker is on, or a choice was recorded). */
  manageable: boolean;
  openSettings: () => void;
  save: (analytics: boolean, marketing: boolean) => void;
  /** The banner while the visitor has not chosen (placed by the layout right after the skip link). */
  banner: ReactNode;
}

const ConsentContext = createContext<ConsentContextValue>({ consent: null, manageable: false, openSettings: () => {}, save: () => {}, banner: null });

export function useConsent(): ConsentContextValue {
  return useContext(ConsentContext);
}

/** Where the banner sits in the reading order: early, so keyboard users reach it right after "skip to content". */
export function ConsentBannerSlot() {
  return <>{useConsent().banner}</>;
}

/** The stored choice if it is for this version and not older than `days`. */
export function readConsent(cookieHeader: string, version: number, days: number, nowSec = Date.now() / 1000): ConsentState | null {
  const c = parseConsent(cookieValue(cookieHeader, CONSENT_COOKIE));
  if (!c || c.version !== version) return null;
  if (c.at > nowSec + 300 || nowSec - c.at > days * 86_400) return null;
  return c;
}

/** First-party, readable by the Worker (Conversions API needs the choice), never sent to third parties. */
export function consentCookie(c: ConsentState, days: number, secure: boolean): string {
  return `${CONSENT_COOKIE}=${serializeConsent(c)}; Path=/; Max-Age=${days * 86_400}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Cookie consent (spec §46) for the public website: banner until the visitor chooses, a settings
 * dialog (also from the footer), and the tracker switch-board. GA4 / Pixel start only after the
 * matching category is accepted; the choice expires after the configured days or when the admin
 * asks everyone again (new version).
 */
export function ConsentProvider({ children }: { children: ReactNode }) {
  const { site } = useSite();
  const { locale } = useI18n();
  const cm = getConsentMessages(locale.code);
  const cfg = site?.consent ?? null;
  const tracking = site?.tracking ?? null;
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [checked, setChecked] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = dialogOpen;

  useEffect(() => {
    if (!cfg) return;
    setConsent(readConsent(document.cookie, cfg.version, cfg.days));
    setChecked(true);
  }, [cfg?.version, cfg?.days]); // eslint-disable-line react-hooks/exhaustive-deps -- cfg object identity changes with language

  // Trackers follow the settings and the choice.
  useEffect(() => {
    if (!tracking || !checked) return;
    configureTracking({ ga4: tracking.ga4MeasurementId, pixel: tracking.metaPixelId, analytics: !!consent?.analytics, marketing: !!consent?.marketing });
  }, [tracking?.ga4MeasurementId, tracking?.metaPixelId, consent?.analytics, consent?.marketing, checked]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Focus back to the button that opened the dialog; when that was in the (now closed) banner, to the page. */
  const restoreFocus = useCallback(() => {
    window.setTimeout(() => {
      const target = opener.current?.isConnected ? opener.current : document.getElementById("main");
      target?.focus({ preventScroll: true });
    }, 0);
  }, []);

  const save = useCallback((analytics: boolean, marketing: boolean) => {
    if (!cfg) return;
    const c: ConsentState = { version: cfg.version, analytics, marketing, at: Math.floor(Date.now() / 1000) };
    document.cookie = consentCookie(c, cfg.days, window.location.protocol === "https:");
    const fromDialog = dialogOpenRef.current;
    setConsent(c);
    setDialogOpen(false);
    setAnnounce(cm.saved);
    window.setTimeout(() => setAnnounce(""), 4000);
    // From the banner, focus goes to the page; from the dialog, back to whatever opened it.
    if (fromDialog || document.activeElement?.closest(".consent-banner")) {
      if (!fromDialog) opener.current = null;
      restoreFocus();
    }
  }, [cfg, cm.saved, restoreFocus]);

  const openSettings = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    restoreFocus();
  }, [restoreFocus]);

  const anyTracker = !!(tracking?.ga4MeasurementId || tracking?.metaPixelId);
  // The banner stays while the settings dialog is open (the modal dialog makes it inert), so focus can return to it.
  const bannerVisible = !!cfg?.enabled && checked && !consent;

  // Floating buttons (booking CTA, LINE) step aside while the banner is up.
  useEffect(() => {
    document.documentElement.classList.toggle("has-consent-banner", bannerVisible);
    return () => document.documentElement.classList.remove("has-consent-banner");
  }, [bannerVisible]);

  const banner = bannerVisible && cfg
    ? <ConsentBanner text={cfg.text} policyPath={cfg.policyPath} onAcceptAll={() => save(true, true)} onReject={() => save(false, false)} onSettings={openSettings} />
    : null;
  const value = useMemo<ConsentContextValue>(() => ({ consent, manageable: anyTracker || !!consent, openSettings, save, banner }),
    [consent, anyTracker, openSettings, save, banner]);

  return (
    <ConsentContext.Provider value={value}>
      {children}
      {dialogOpen && (
        <ConsentDialog initial={consent} onSave={save} onClose={closeDialog} policyPath={cfg?.policyPath ?? null} />
      )}
      <p className="visually-hidden" role="status" aria-live="polite">{announce}</p>
    </ConsentContext.Provider>
  );
}
