/**
 * Supported languages. This is configuration, not content: adding a language
 * means adding an entry here plus a dictionary in ./messages.
 *
 * - `code`     BCP-47 tag used in <html lang>, hreflang and the database `language_code`.
 * - `path`     lowercase URL segment, e.g. /zh-cn/gallery.
 * - `label`    the language's own name (endonym) for the language switcher.
 */
export const LOCALES = [
  { code: "th", path: "th", label: "ไทย", shortLabel: "TH" },
  { code: "en", path: "en", label: "English", shortLabel: "EN" },
  { code: "zh-CN", path: "zh-cn", label: "简体中文", shortLabel: "中文" },
] as const;

export type Locale = (typeof LOCALES)[number];
export type LocaleCode = Locale["code"];
export type LocalePath = Locale["path"];

export const DEFAULT_LOCALE_CODE: LocaleCode = "th";

export const LOCALE_CODES: readonly LocaleCode[] = LOCALES.map((l) => l.code);

export function getLocale(code: LocaleCode): Locale {
  const found = LOCALES.find((l) => l.code === code);
  if (!found) throw new Error(`Unknown locale code: ${code}`);
  return found;
}

export const DEFAULT_LOCALE: Locale = getLocale(DEFAULT_LOCALE_CODE);

/** Accepts a URL segment (case-insensitive), returns the locale or undefined. */
export function localeFromPath(segment: string | undefined | null): Locale | undefined {
  if (!segment) return undefined;
  const lower = segment.toLowerCase();
  return LOCALES.find((l) => l.path === lower);
}

/**
 * Accepts either a BCP-47 code ("zh-CN") or a path segment ("zh-cn"), case-insensitive.
 * Used to validate `?lang=` on the API.
 */
export function parseLocale(input: string | undefined | null): Locale | undefined {
  if (!input) return undefined;
  const lower = input.trim().toLowerCase();
  return LOCALES.find((l) => l.code.toLowerCase() === lower || l.path === lower);
}
