import { useRef, useState, type FormEvent } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { FONT_FALLBACKS, FONT_WEIGHTS, MAX_FONT_BYTES, type CustomFontDto } from "../../../shared/media-types.ts";
import { CUSTOM_FONT_FAMILY } from "../../../shared/theme.ts";
import { apiRequest, apiUpload } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, fieldErrors } from "../ui.tsx";

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Uploaded web fonts (Phase 12): WOFF2 / WOFF files, one per weight + style of a family.
 * The server re-checks the file signature; this form only catches the obvious mistakes early.
 */
export function FontLibrary({ fonts, onChange }: { fonts: CustomFontDto[]; onChange: (fonts: CustomFontDto[]) => void }) {
  const { t, c } = useAdmin();
  const f = c.theme.fonts;
  const fileRef = useRef<HTMLInputElement>(null);
  const [family, setFamily] = useState("");
  const [weight, setWeight] = useState(400);
  const [style, setStyle] = useState<"normal" | "italic">("normal");
  const [fallback, setFallback] = useState<(typeof FONT_FALLBACKS)[number]>("SANS");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<CustomFontDto | null>(null);
  const fontLabel = (x: CustomFontDto) => `${x.family} ${x.weight}${x.style === "italic" ? ` ${f.styleItalic}` : ""}`;

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const file = fileRef.current?.files?.[0];
    const local: Record<string, string> = {};
    const name = family.trim().replace(/\s+/g, " ");
    if (!CUSTOM_FONT_FAMILY.test(name)) local.family = name ? t.errors.INVALID_FORMAT : t.errors.REQUIRED;
    if (!file) local.file = t.errors.REQUIRED;
    else if (!/\.(woff2?)$/i.test(file.name)) local.file = t.errors.UNSUPPORTED_FONT;
    else if (file.size > MAX_FONT_BYTES) local.file = t.errors.FONT_TOO_LARGE;
    setErrors(local);
    if (Object.keys(local).length) return;
    const form = new FormData();
    form.set("file", file!);
    form.set("family", name);
    form.set("weight", String(weight));
    form.set("style", style);
    form.set("fallback", fallback);
    setBusy(true);
    try {
      const font = await apiUpload<CustomFontDto>("/api/admin/fonts", form);
      onChange([...fonts, font].sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || a.style.localeCompare(b.style)));
      setMessage({ kind: "success", text: f.uploaded });
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(font: CustomFontDto) {
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      await apiRequest("DELETE", `/api/admin/fonts/${encodeURIComponent(font.id)}`);
      onChange(fonts.filter((x) => x.id !== font.id));
      setMessage({ kind: "success", text: f.deleted });
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  const families = [...new Set(fonts.map((x) => x.family))];
  return (
    <div className="adm-card">
      <h2 className="adm-h2">{f.title}</h2>
      <p className="adm-field__hint">{f.intro}</p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      {fonts.length === 0 ? <p className="adm-muted">{f.empty}</p> : (
        <ul className="adm-cmslist font-list">
          {fonts.map((x) => (
            <li key={x.id} className="adm-cmsitem">
              <div className="adm-cmsitem__body">
                <div><strong>{fontLabel(x)}</strong> <span className="adm-small adm-muted">{x.format.toUpperCase()}, {sizeText(x.sizeBytes)}</span></div>
                <p className="font-sample" style={{ fontFamily: x.token, fontWeight: x.weight, fontStyle: x.style }}>{f.sample}</p>
              </div>
              <div className="adm-cmsitem__actions">
                <Button variant="danger" disabled={busy} onClick={() => setConfirm(x)}>{f.delete}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form className="font-upload" onSubmit={(e) => void upload(e)} noValidate>
        <fieldset className="adm-fieldset" disabled={busy}>
          <div className="adm-grid2">
            <div className="adm-field">
              <label htmlFor="font-family">{f.family}</label>
              <input id="font-family" value={family} maxLength={40} list="font-families" autoComplete="off"
                aria-invalid={!!errors.family || undefined} aria-describedby="font-family-hint"
                onChange={(e) => setFamily(e.currentTarget.value)} />
              <datalist id="font-families">{families.map((x) => <option key={x} value={x} />)}</datalist>
              <p id="font-family-hint" className="adm-field__hint">{f.familyHint}</p>
              {errors.family && <p className="adm-field__error">{errors.family}</p>}
            </div>
            <div className="adm-field">
              <label htmlFor="font-file">{f.file}</label>
              <input id="font-file" ref={fileRef} type="file" accept=".woff2,.woff,font/woff2,font/woff" aria-invalid={!!errors.file || undefined} />
              {errors.file && <p className="adm-field__error">{errors.file}</p>}
            </div>
            <div className="adm-field">
              <label htmlFor="font-weight">{f.weight}</label>
              <select id="font-weight" value={String(weight)} onChange={(e) => setWeight(Number(e.currentTarget.value))}>
                {FONT_WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor="font-style">{f.style}</label>
              <select id="font-style" value={style} onChange={(e) => setStyle(e.currentTarget.value as "normal" | "italic")}>
                <option value="normal">{f.styleNormal}</option>
                <option value="italic">{f.styleItalic}</option>
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor="font-fallback">{f.fallback}</label>
              <select id="font-fallback" value={fallback} aria-describedby="font-fallback-hint"
                onChange={(e) => setFallback(e.currentTarget.value as (typeof FONT_FALLBACKS)[number])}>
                {FONT_FALLBACKS.map((k) => <option key={k} value={k}>{(c.theme as unknown as Record<string, string>)[`font${k}`]}</option>)}
              </select>
              <p id="font-fallback-hint" className="adm-field__hint">{f.fallbackHint}</p>
            </div>
          </div>
          <Button type="submit" busy={busy}>{f.upload}</Button>
        </fieldset>
      </form>

      <ConfirmDialog open={!!confirm} danger message={confirm ? format(f.confirmDelete, { name: fontLabel(confirm) }) : ""} confirmLabel={f.delete}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const x = confirm; setConfirm(null); if (x) void remove(x); }} />
    </div>
  );
}
