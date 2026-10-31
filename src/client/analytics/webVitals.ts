import { vitalRating } from "../../shared/analytics.ts";
import { track } from "./tracker.ts";

/**
 * Core Web Vitals of the page the visitor opened (LCP, CLS, INP), measured with the browser's own
 * PerformanceObserver (no library) and sent once to GA4 when the page is hidden or left. Like every other
 * event it goes through track(): nothing is sent without Analytics consent.
 * Simplified from Google's web-vitals rules: CLS = largest session window (gap < 1 s, window ≤ 5 s);
 * INP = slowest interaction (≈ the 98th percentile for the few dozen interactions of a visit).
 */
let started = false;

export function startWebVitals(): void {
  if (started || typeof window === "undefined" || typeof PerformanceObserver === "undefined") return;
  started = true;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const page = window.location.pathname;
  let lcp = -1;
  let cls = 0;
  let session = 0;
  let sessionStart = 0;
  let sessionLast = 0;
  const interactions = new Map<number, number>();
  const observers: PerformanceObserver[] = [];

  const observe = (type: string, onEntries: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
    if (!supported.includes(type)) return;
    try {
      const o = new PerformanceObserver((list) => onEntries(list.getEntries()));
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(o);
    } catch {
      // an older browser without this entry type: that metric is simply not reported
    }
  };

  observe("largest-contentful-paint", (entries) => {
    const last = entries.at(-1);
    if (last) lcp = last.startTime;
  });
  observe("layout-shift", (entries) => {
    for (const e of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (e.hadRecentInput) continue;
      if (session && e.startTime - sessionLast < 1000 && e.startTime - sessionStart < 5000) {
        session += e.value;
      } else {
        session = e.value;
        sessionStart = e.startTime;
      }
      sessionLast = e.startTime;
      cls = Math.max(cls, session);
    }
  });
  observe("event", (entries) => {
    for (const e of entries as (PerformanceEntry & { interactionId?: number })[]) {
      if (!e.interactionId) continue;
      interactions.set(e.interactionId, Math.max(interactions.get(e.interactionId) ?? 0, e.duration));
    }
  }, { durationThreshold: 40 });

  let sent = false;
  const report = () => {
    if (sent) return;
    sent = true;
    for (const o of observers) o.disconnect();
    if (lcp >= 0) track({ name: "web_vitals", metric: "LCP", value: lcp, rating: vitalRating("LCP", lcp), page });
    if (supported.includes("layout-shift")) track({ name: "web_vitals", metric: "CLS", value: cls, rating: vitalRating("CLS", cls), page });
    if (interactions.size) {
      const sorted = [...interactions.values()].sort((a, b) => b - a);
      const inp = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))]!;
      track({ name: "web_vitals", metric: "INP", value: inp, rating: vitalRating("INP", inp), page });
    }
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") report(); });
  window.addEventListener("pagehide", report);
}
