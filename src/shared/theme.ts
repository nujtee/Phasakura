/**
 * Theme tokens (spec §37) and presets (spec §38).
 *
 * A theme is a map of CSS custom properties → values. Every value is validated
 * against a closed set of shapes (hex colours, px radii, listed font stacks and
 * shadows), so a stored theme can never inject arbitrary CSS. The published theme
 * is applied at runtime on :root; `tokens.css` holds neutral fallbacks only.
 */

export const COLOR_TOKENS = [
  "--color-primary", "--color-primary-contrast", "--color-secondary", "--color-accent",
  "--color-background", "--color-surface", "--color-text", "--color-heading", "--color-muted", "--color-border",
  "--color-success", "--color-warning", "--color-error", "--color-info",
] as const;
export const FONT_TOKENS = ["--font-body", "--font-heading", "--font-button"] as const;
export const RADIUS_TOKENS = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"] as const;
export const SHADOW_TOKENS = ["--shadow-sm", "--shadow-md", "--shadow-lg"] as const;

export type ThemeToken =
  | (typeof COLOR_TOKENS)[number] | (typeof FONT_TOKENS)[number] | (typeof RADIUS_TOKENS)[number] | (typeof SHADOW_TOKENS)[number];
export const THEME_TOKENS: readonly ThemeToken[] = [...COLOR_TOKENS, ...FONT_TOKENS, ...RADIUS_TOKENS, ...SHADOW_TOKENS];
export type ThemeTokens = Partial<Record<ThemeToken, string>>;

/** System font stacks with Thai + Simplified Chinese coverage (no external font requests). */
export const FONT_STACKS = {
  SANS: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif',
  ROUNDED: 'ui-rounded, "SF Pro Rounded", "Noto Sans Thai", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  SERIF: 'ui-serif, Georgia, "Noto Serif Thai", "Noto Serif SC", "Songti SC", "SimSun", Cambria, "Times New Roman", serif',
  MONO: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Noto Sans Mono", "Noto Sans Thai", monospace',
} as const;
export type FontStackKey = keyof typeof FONT_STACKS;

export const SHADOW_LEVELS = {
  NONE: { sm: "none", md: "none", lg: "none" },
  SOFT: { sm: "0 1px 2px rgb(18 24 21 / 0.06)", md: "0 4px 12px rgb(18 24 21 / 0.08)", lg: "0 12px 32px rgb(18 24 21 / 0.12)" },
  STRONG: { sm: "0 1px 3px rgb(0 0 0 / 0.16)", md: "0 6px 18px rgb(0 0 0 / 0.18)", lg: "0 18px 44px rgb(0 0 0 / 0.24)" },
} as const;
export type ShadowLevel = keyof typeof SHADOW_LEVELS;

const HEX = /^#[0-9a-fA-F]{6}$/;
const PX = /^(\d{1,2})px$/;

/** Field-level errors for a token map (empty object = valid). */
export function validateThemeTokens(tokens: unknown): Record<string, string> {
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) return { tokens: "EXPECTED_OBJECT" };
  const errors: Record<string, string> = {};
  const fonts = Object.values(FONT_STACKS) as string[];
  for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (!(THEME_TOKENS as readonly string[]).includes(key)) { errors[key] = "UNKNOWN_TOKEN"; continue; }
    if (typeof value !== "string") { errors[key] = "EXPECTED_STRING"; continue; }
    if ((COLOR_TOKENS as readonly string[]).includes(key) && !HEX.test(value)) errors[key] = "INVALID_COLOR";
    if ((FONT_TOKENS as readonly string[]).includes(key) && !fonts.includes(value)) errors[key] = "INVALID_FONT";
    if ((RADIUS_TOKENS as readonly string[]).includes(key)) {
      const m = PX.exec(value);
      if (!m || Number(m[1]) > 48) errors[key] = "INVALID_RADIUS";
    }
    if ((SHADOW_TOKENS as readonly string[]).includes(key)) {
      const size = key.slice("--shadow-".length) as "sm" | "md" | "lg";
      if (!Object.values(SHADOW_LEVELS).some((l) => l[size] === value)) errors[key] = "INVALID_SHADOW";
    }
  }
  return errors;
}

/** Relative luminance contrast ratio of two #RRGGBB colours (WCAG 2.x). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export const THEME_PRESETS = ["DEFAULT", "NATURE", "FOREST", "MOUNTAIN", "SAKURA", "LUXURY", "MINIMAL", "WARM", "MODERN", "DARK"] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number] | "CUSTOM";

function preset(
  colors: [primary: string, contrast: string, secondary: string, accent: string, background: string, surface: string,
    text: string, heading: string, muted: string, border: string],
  font: FontStackKey,
  heading: FontStackKey,
  radius: [number, number, number, number],
  shadow: ShadowLevel,
): Required<ThemeTokens> {
  const [primary, contrast, secondary, accent, background, surface, text, headingColor, muted, border] = colors;
  const s = SHADOW_LEVELS[shadow];
  return {
    "--color-primary": primary, "--color-primary-contrast": contrast, "--color-secondary": secondary, "--color-accent": accent,
    "--color-background": background, "--color-surface": surface, "--color-text": text, "--color-heading": headingColor,
    "--color-muted": muted, "--color-border": border,
    "--color-success": "#2e7d4f", "--color-warning": "#a86400", "--color-error": "#b3261e", "--color-info": "#2860a8",
    "--font-body": FONT_STACKS[font], "--font-heading": FONT_STACKS[heading], "--font-button": FONT_STACKS[font],
    "--radius-sm": `${radius[0]}px`, "--radius-md": `${radius[1]}px`, "--radius-lg": `${radius[2]}px`, "--radius-xl": `${radius[3]}px`,
    "--shadow-sm": s.sm, "--shadow-md": s.md, "--shadow-lg": s.lg,
  };
}

/** Starting points; the admin can change every token before publishing. */
export const PRESET_TOKENS: Record<(typeof THEME_PRESETS)[number], Required<ThemeTokens>> = {
  DEFAULT: preset(["#2f5d50", "#ffffff", "#6b7f5e", "#c9785b", "#fbfaf7", "#ffffff", "#1f2622", "#121815", "#5b6660", "#e3e1da"], "SANS", "SANS", [6, 10, 16, 24], "SOFT"),
  NATURE: preset(["#3b6b3a", "#ffffff", "#8a9a5b", "#d39b4a", "#f7f8f1", "#ffffff", "#20281d", "#141a12", "#5d6857", "#dfe3d3"], "SANS", "SANS", [8, 12, 18, 28], "SOFT"),
  FOREST: preset(["#1f4d3a", "#ffffff", "#3f6f5a", "#b8873b", "#f2f5f1", "#ffffff", "#17221c", "#0e1712", "#52615a", "#d6ded8"], "SANS", "SERIF", [4, 8, 12, 20], "SOFT"),
  MOUNTAIN: preset(["#35556f", "#ffffff", "#6f8597", "#c47f45", "#f5f7f9", "#ffffff", "#1d2733", "#121a24", "#5a6878", "#dbe2e8"], "SANS", "SANS", [6, 10, 14, 22], "SOFT"),
  SAKURA: preset(["#b0476b", "#ffffff", "#d68aa3", "#5f8a6a", "#fff8fa", "#ffffff", "#2d1f25", "#1f1418", "#6e5862", "#f0dce3"], "ROUNDED", "ROUNDED", [10, 14, 20, 32], "SOFT"),
  LUXURY: preset(["#1c1c1c", "#f3e7c9", "#5a4a32", "#b8954a", "#f8f5ee", "#ffffff", "#1b1a17", "#0d0c0a", "#625d52", "#e4ddcd"], "SANS", "SERIF", [2, 4, 8, 12], "STRONG"),
  MINIMAL: preset(["#222222", "#ffffff", "#555555", "#0a7cff", "#ffffff", "#ffffff", "#1a1a1a", "#000000", "#666666", "#e6e6e6"], "SANS", "SANS", [0, 2, 4, 8], "NONE"),
  WARM: preset(["#a3542a", "#ffffff", "#c28b5a", "#4f7a5c", "#fdf7f1", "#ffffff", "#2b1f17", "#1d140e", "#6d5b4d", "#eedfd2"], "ROUNDED", "SERIF", [8, 12, 18, 26], "SOFT"),
  MODERN: preset(["#3446d6", "#ffffff", "#5f6c86", "#ff7a45", "#f6f7fb", "#ffffff", "#161a26", "#0b0e17", "#5a6275", "#dde1ec"], "SANS", "SANS", [8, 12, 16, 24], "STRONG"),
  DARK: preset(["#7cc4a1", "#0e1512", "#9bb59b", "#e7a46b", "#111614", "#1a211e", "#e3ebe6", "#f5faf7", "#a3b1aa", "#2c3632"], "SANS", "SANS", [6, 10, 16, 24], "STRONG"),
};
