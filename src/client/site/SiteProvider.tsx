import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicSiteDto } from "../../shared/api-types.ts";
import type { Locale } from "../../shared/i18n/index.ts";
import { apiGet } from "../api/client.ts";

export type SiteState =
  | { status: "loading"; site: PublicSiteDto | null; retry: () => void }
  | { status: "ready"; site: PublicSiteDto; retry: () => void }
  | { status: "error"; site: PublicSiteDto | null; retry: () => void };

const noop = () => {};

export const SiteContext = createContext<SiteState>({ status: "loading", site: null, retry: noop });

/** Loads website name / tagline / logo from D1+R2 via the public API. */
export function SiteProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const [state, setState] = useState<SiteState>({ status: "loading", site: null, retry });

  useEffect(() => {
    const controller = new AbortController();
    // Keep the previous site while switching language to avoid header flicker.
    setState((prev) => ({ status: "loading", site: prev.site, retry }));
    apiGet<PublicSiteDto>(`/api/public/site?lang=${encodeURIComponent(locale.path)}`, controller.signal)
      .then((site) => setState({ status: "ready", site, retry }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("Failed to load site settings", error);
        setState((prev) => ({ status: "error", site: prev.site, retry }));
      });
    return () => controller.abort();
  }, [locale, attempt, retry]);

  return <SiteContext.Provider value={state}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteState {
  return useContext(SiteContext);
}
