import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicSiteDto } from "../../shared/api-types.ts";
import type { Locale } from "../../shared/i18n/index.ts";
import type { PublicFontFaceDto } from "../../shared/media-types.ts";
import { THEME_TOKENS, validateThemeTokens, type ThemeTokens } from "../../shared/theme.ts";
import { apiGet } from "../api/client.ts";

export type SiteState =
  | { status: "loading"; site: PublicSiteDto | null; retry: () => void; preview: boolean; exitPreview: () => void }
  | { status: "ready"; site: PublicSiteDto; retry: () => void; preview: boolean; exitPreview: () => void }
  | { status: "error"; site: PublicSiteDto | null; retry: () => void; preview: boolean; exitPreview: () => void };

const noop = () => {};
const PREVIEW_KEY = "phasakura.themePreview";

export const SiteContext = createContext<SiteState>({ status: "loading", site: null, retry: noop, preview: false, exitPreview: noop });

/**
 * Applies theme tokens on :root through CSSOM (allowed by the CSP, unlike inline <style>).
 * Only known token names with valid values are set; everything else keeps the tokens.css fallback.
 * Returns a cleanup that removes exactly what was set (the admin area keeps its neutral look).
 */
export function applyTheme(tokens: ThemeTokens | null | undefined, target: HTMLElement = document.documentElement): () => void {
  // Uploaded families were checked against the font library on the server; here only the format matters.
  if (!tokens || Object.keys(validateThemeTokens(tokens, "any")).length > 0) return noop;
  const set: string[] = [];
  for (const name of THEME_TOKENS) {
    const value = tokens[name];
    if (value) {
      target.style.setProperty(name, value);
      set.push(name);
    }
  }
  return () => set.forEach((name) => target.style.removeProperty(name));
}

/**
 * Registers uploaded web fonts with the FontFace API (no inline <style>, so the CSP stays strict).
 * Faces load only when text uses them; if a file fails, the token's system fallback stack is used.
 */
export function loadFonts(faces: readonly PublicFontFaceDto[], fontSet: FontFaceSet | undefined = typeof document !== "undefined" ? document.fonts : undefined): () => void {
  if (!faces.length || !fontSet || typeof FontFace === "undefined") return noop;
  const added: FontFace[] = [];
  for (const f of faces) {
    if (!/^(https:\/\/|\/)/.test(f.url)) continue;
    try {
      const face = new FontFace(f.family, `url(${JSON.stringify(f.url)}) format("${f.format}")`, {
        weight: String(f.weight), style: f.style, display: "swap",
      });
      fontSet.add(face);
      added.push(face);
    } catch {
      // Malformed descriptor: keep the fallback stack.
    }
  }
  return () => added.forEach((face) => fontSet.delete(face));
}

function readPreviewFlag(): boolean {
  try {
    if (new URLSearchParams(window.location.search).has("themePreview")) window.sessionStorage.setItem(PREVIEW_KEY, "1");
    return window.sessionStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return new URLSearchParams(window.location.search).has("themePreview");
  }
}

/** Loads website name / tagline / logo / theme / contact from D1+R2 via the public API. */
export function SiteProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const [preview, setPreview] = useState(false);
  const [previewTokens, setPreviewTokens] = useState<ThemeTokens | null>(null);
  const [previewFonts, setPreviewFonts] = useState<PublicFontFaceDto[] | null>(null);
  const exitPreview = useCallback(() => {
    try {
      window.sessionStorage.removeItem(PREVIEW_KEY);
    } catch {
      // ignore
    }
    setPreview(false);
    setPreviewTokens(null);
    setPreviewFonts(null);
  }, []);
  const [state, setState] = useState<Omit<SiteState, "preview" | "exitPreview">>({ status: "loading", site: null, retry });

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

  // "Preview on the live website": draft tokens for a signed-in theme editor only (the API checks the session).
  useEffect(() => {
    if (!readPreviewFlag()) return;
    const controller = new AbortController();
    apiGet<{ tokens: ThemeTokens; fonts?: PublicFontFaceDto[] }>("/api/admin/theme/preview", controller.signal)
      .then((res) => { setPreviewTokens(res.tokens); setPreviewFonts(res.fonts ?? []); setPreview(true); })
      .catch(() => { if (!controller.signal.aborted) exitPreview(); });
    return () => controller.abort();
  }, [exitPreview]);

  const tokens = previewTokens ?? state.site?.theme ?? null;
  useEffect(() => applyTheme(tokens), [tokens]);

  // Uploaded fonts the (published or previewed) theme uses.
  const fonts = previewFonts ?? state.site?.fonts ?? null;
  const fontKey = fonts ? JSON.stringify(fonts) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content: a refetch with the same faces must not re-register them
  useEffect(() => (fonts ? loadFonts(fonts) : noop), [fontKey]);

  // Favicon from Branding (R2), replacing the empty placeholder in index.html.
  const favicon = state.site?.favicon ?? null;
  useEffect(() => {
    if (!favicon) return;
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']") ?? document.head.appendChild(document.createElement("link"));
    const previous = link.getAttribute("href");
    link.rel = "icon";
    link.href = favicon;
    return () => { if (previous !== null) link.setAttribute("href", previous); };
  }, [favicon]);

  return <SiteContext.Provider value={{ ...state, preview, exitPreview } as SiteState}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteState {
  return useContext(SiteContext);
}
