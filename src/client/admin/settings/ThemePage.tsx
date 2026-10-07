import { useEffect, useRef, useState } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import type { ThemeAdminDto } from "../../../shared/settings-types.ts";
import {
  COLOR_TOKENS, contrastRatio, FONT_STACKS, FONT_TOKENS, PRESET_TOKENS, RADIUS_TOKENS, SHADOW_LEVELS, THEME_PRESETS,
  type FontStackKey, type ShadowLevel, type ThemePreset, type ThemeToken, type ThemeTokens,
} from "../../../shared/theme.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { applyTheme } from "../../site/SiteProvider.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { StatusPill } from "../cms/CmsKit.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, fieldErrors, useDateFormatter } from "../ui.tsx";

const PRESET_LABEL: Record<string, string> = {
  DEFAULT: "Default", NATURE: "Nature", FOREST: "Forest", MOUNTAIN: "Mountain", SAKURA: "Sakura", LUXURY: "Luxury",
  MINIMAL: "Minimal", WARM: "Warm", MODERN: "Modern", DARK: "Dark",
};

function fontKey(stack: string | undefined): FontStackKey {
  return (Object.entries(FONT_STACKS).find(([, v]) => v === stack)?.[0] as FontStackKey | undefined) ?? "SANS";
}

function shadowLevel(tokens: ThemeTokens): ShadowLevel {
  return (Object.entries(SHADOW_LEVELS).find(([, l]) => l.md === tokens["--shadow-md"])?.[0] as ShadowLevel | undefined) ?? "SOFT";
}

/** Theme (spec §37–38): presets, token editor with live preview, draft → preview → publish, history + rollback. */
export function ThemePage() {
  const { t, c, locale } = useAdmin();
  const dateTime = useDateFormatter();
  const [data, setData] = useState<ThemeAdminDto | null>(null);
  const [preset, setPreset] = useState<ThemePreset>("DEFAULT");
  const [tokens, setTokens] = useState<ThemeTokens>(PRESET_TOKENS.DEFAULT);
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ kind: "publish" } | { kind: "rollback"; id: string; n: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  function adopt(d: ThemeAdminDto) {
    setData(d);
    const base = d.draft ?? d.published;
    setPreset(base?.preset ?? "DEFAULT");
    setTokens({ ...PRESET_TOKENS.DEFAULT, ...(base?.tokens ?? {}) });
    setNote(d.draft?.note ?? "");
    setDirty(false);
  }

  useEffect(() => {
    apiGet<ThemeAdminDto>("/api/admin/theme").then(adopt).catch((err: unknown) => setMessage({ kind: "error", text: detailMessage(t, err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live preview: the same CSS variables, scoped to the preview box.
  useEffect(() => (previewRef.current ? applyTheme(tokens, previewRef.current) : undefined), [tokens]);

  const setToken = (k: ThemeToken, v: string) => { setTokens((x) => ({ ...x, [k]: v })); setPreset("CUSTOM"); setDirty(true); };

  async function run(fn: () => Promise<ThemeAdminDto>, ok: string) {
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      adopt(await fn());
      setMessage({ kind: "success", text: ok });
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  const saveDraft = () => run(() => apiRequest("PUT", "/api/admin/theme/draft", { preset, tokens, note: note.trim() || null }), t.common.saved);
  const contrast = (a: ThemeToken, b: ThemeToken) => {
    const x = tokens[a];
    const y = tokens[b];
    return x && y ? contrastRatio(x, y) : 21;
  };
  const warnings = ([["--color-text", "--color-background"], ["--color-text", "--color-surface"], ["--color-primary-contrast", "--color-primary"]] as const)
    .map(([a, b]) => ({ a, b, ratio: contrast(a, b) })).filter((w) => w.ratio < 4.5);
  const label = (k: string) => (c.theme.tokens as Record<string, string>)[k] ?? k;

  return (
    <section>
      <h1 className="adm-h1">{c.theme.title}</h1>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {!data && !message && <p role="status">{t.common.loading}</p>}
      {data && (
        <>
          <div className="adm-card">
            <div className="adm-row adm-row--wrap">
              {data.published && <span>{c.theme.live}: <strong>{format(c.theme.version, { n: data.published.versionNumber })}</strong> ({PRESET_LABEL[data.published.preset] ?? c.theme.presetCUSTOM})</span>}
              {data.draft ? <span>· {c.theme.draft}: <strong>{format(c.theme.version, { n: data.draft.versionNumber })}</strong></span> : <span className="adm-muted">· {c.theme.noDraft}</span>}
              {dirty && <span className="adm-badge adm-badge--warning">{c.ui.unsaved}</span>}
            </div>
          </div>

          <div className="adm-card">
            <h2 className="adm-h2">{c.theme.presets}</h2>
            <ul className="thm-presets">
              {THEME_PRESETS.map((p) => (
                <li key={p}>
                  <button type="button" className="thm-preset" aria-pressed={preset === p}
                    onClick={() => { setPreset(p); setTokens(PRESET_TOKENS[p]); setDirty(true); }}>
                    <span className="thm-swatches" aria-hidden="true">
                      {(["--color-background", "--color-primary", "--color-secondary", "--color-accent"] as const).map((k) => (
                        <span key={k} style={{ background: PRESET_TOKENS[p][k] }} />
                      ))}
                    </span>
                    {PRESET_LABEL[p]}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="thm-layout">
            <form className="adm-card" onSubmit={(e) => { e.preventDefault(); void saveDraft(); }}>
              <fieldset className="adm-fieldset" disabled={busy}>
                <h2 className="adm-h2">{c.theme.colors}</h2>
                <div className="thm-colors">
                  {COLOR_TOKENS.map((k) => (
                    <label key={k} className="thm-color">
                      <input type="color" value={tokens[k] ?? "#000000"} onChange={(e) => setToken(k, e.currentTarget.value)} />
                      <span>{label(k)}<span className="adm-mono adm-small adm-muted"> {tokens[k]}</span></span>
                      {errors[`tokens.${k}`] && <span className="adm-field__error">{errors[`tokens.${k}`]}</span>}
                    </label>
                  ))}
                </div>
                {warnings.map((w) => (
                  <p key={`${w.a}${w.b}`} className="adm-small adm-text-error" role="status">
                    {label(w.a)} / {label(w.b)}: {format(c.theme.contrastLow, { ratio: w.ratio.toFixed(1) })}
                  </p>
                ))}

                <h2 className="adm-h2">{c.theme.typography}</h2>
                <div className="adm-grid2">
                  {FONT_TOKENS.map((k) => (
                    <div key={k} className="adm-field">
                      <label htmlFor={`thm-${k}`}>{label(k)}</label>
                      <select id={`thm-${k}`} value={fontKey(tokens[k])} onChange={(e) => setToken(k, FONT_STACKS[e.currentTarget.value as FontStackKey])}>
                        {(Object.keys(FONT_STACKS) as FontStackKey[]).map((f) => (
                          <option key={f} value={f}>{(c.theme as unknown as Record<string, string>)[`font${f}`]}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <p className="adm-field__hint">{c.theme.fontNote}</p>

                <h2 className="adm-h2">{c.theme.shape}</h2>
                <div className="adm-grid2">
                  {RADIUS_TOKENS.map((k) => (
                    <div key={k} className="adm-field">
                      <label htmlFor={`thm-${k}`}>{label(k)} (px)</label>
                      <input id={`thm-${k}`} type="number" min={0} max={48} value={parseInt(tokens[k] ?? "0", 10)}
                        onChange={(e) => setToken(k, `${Math.max(0, Math.min(48, Number(e.currentTarget.value) || 0))}px`)} />
                    </div>
                  ))}
                  <div className="adm-field">
                    <label htmlFor="thm-shadow">{c.theme.shadowLevel}</label>
                    <select id="thm-shadow" value={shadowLevel(tokens)} onChange={(e) => {
                      const l = SHADOW_LEVELS[e.currentTarget.value as ShadowLevel];
                      setTokens((x) => ({ ...x, "--shadow-sm": l.sm, "--shadow-md": l.md, "--shadow-lg": l.lg }));
                      setPreset("CUSTOM");
                      setDirty(true);
                    }}>
                      {(Object.keys(SHADOW_LEVELS) as ShadowLevel[]).map((l) => (
                        <option key={l} value={l}>{(c.theme as unknown as Record<string, string>)[`shadow${l}`]}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="adm-field">
                  <label htmlFor="thm-note">{c.theme.note}</label>
                  <input id="thm-note" maxLength={200} value={note} onChange={(e) => { setNote(e.currentTarget.value); setDirty(true); }} />
                </div>
                <div className="adm-row adm-row--wrap">
                  <Button type="submit" busy={busy}>{c.theme.saveDraft}</Button>
                  <Button variant="primary" disabled={!data.draft || dirty} onClick={() => setConfirm({ kind: "publish" })}>{c.theme.publish}</Button>
                  {data.draft && !dirty && (
                    <a className="adm-btn adm-btn--secondary" href={`/${locale.path}/?themePreview=1`} target="_blank" rel="noopener">{c.theme.previewSite}</a>
                  )}
                  {data.draft && <Button variant="ghost" onClick={() => run(() => apiRequest("DELETE", "/api/admin/theme/draft"), t.common.saved)}>{c.theme.discard}</Button>}
                </div>
              </fieldset>
            </form>

            <div className="adm-card thm-sticky">
              <h2 className="adm-h2">{c.theme.preview}</h2>
              <div ref={previewRef} className="thm-preview">
                <div className="thm-preview__header"><strong>Logo</strong><span>Home · Gallery</span></div>
                <div className="thm-preview__body">
                  <h3 className="thm-preview__h">{c.theme.sample.heading}</h3>
                  <p>{c.theme.sample.text}</p>
                  <p className="thm-preview__muted">{c.theme.sample.muted}</p>
                  <div className="thm-preview__card">
                    <strong>{c.theme.sample.card}</strong>
                    <span className="thm-preview__accent">฿3,500</span>
                  </div>
                  <input className="thm-preview__input" placeholder={c.theme.sample.input} aria-label={c.theme.sample.input} readOnly />
                  <div className="thm-preview__buttons">
                    <span className="thm-preview__btn">{c.theme.sample.button}</span>
                    <span className="thm-preview__btn thm-preview__btn--secondary">{c.theme.sample.secondary}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="adm-card">
            <h2 className="adm-h2">{c.theme.history}</h2>
            <ul className="adm-cmslist">
              {data.history.map((v) => (
                <li key={v.id} className="adm-cmsitem">
                  <span className="thm-swatches" aria-hidden="true">
                    {(["--color-background", "--color-primary", "--color-secondary", "--color-accent"] as const).map((k) => <span key={k} style={{ background: v.tokens[k] }} />)}
                  </span>
                  <div className="adm-cmsitem__body">
                    <div>
                      <strong>{format(c.theme.version, { n: v.versionNumber })}</strong> · {PRESET_LABEL[v.preset] ?? c.theme.presetCUSTOM}
                      {v.note && <span className="adm-muted"> · {v.note}</span>}
                    </div>
                    <div className="adm-small adm-muted">{dateTime(v.publishedAt)}{v.publishedByName ? ` · ${v.publishedByName}` : ""}</div>
                  </div>
                  <div className="adm-cmsitem__actions">
                    <StatusPill status={v.status === "PUBLISHED" ? "PUBLISHED" : "ARCHIVED"} />
                    {v.status === "ARCHIVED" && <Button variant="secondary" disabled={busy} onClick={() => setConfirm({ kind: "rollback", id: v.id, n: v.versionNumber })}>{c.theme.rollback}</Button>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <ConfirmDialog open={!!confirm}
        message={confirm?.kind === "rollback" ? format(c.theme.confirmRollback, { n: confirm.n }) : c.theme.confirmPublish}
        confirmLabel={confirm?.kind === "rollback" ? c.theme.rollback : c.theme.publish}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const x = confirm;
          setConfirm(null);
          if (x?.kind === "publish") void run(() => apiRequest("POST", "/api/admin/theme/publish"), c.ui.published);
          if (x?.kind === "rollback") void run(() => apiRequest("POST", `/api/admin/theme/versions/${x.id}/rollback`), c.ui.published);
        }} />
    </section>
  );
}
