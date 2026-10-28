import { useState } from "react";
import type { AdminLandscapeMessages } from "../../../shared/i18n/admin-landscape-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import {
  LANDSCAPE_LIMITS, LANDSCAPE_OBJECT_KINDS, PALETTE_GROUPS, PALETTE_LAYERS, RESERVABLE_KINDS, SHAPE_TYPES,
  type LandscapeObjectKind, type LandscapePaletteInput, type LandscapePaletteRowDto,
} from "../../../shared/landscape-types.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { KIND_INFO } from "../../landscape/kinds.ts";
import { defaultLook, entryInput, swapOrder, type PaletteEntry } from "../../landscape/palette.ts";
import { Button } from "../ui.tsx";
import { LookPicker } from "./LookPicker.tsx";

type E = AdminLandscapeMessages["editor"];

/** A small square of a palette entry's colours (SVG: no inline style). */
export function Swatch({ entry }: { entry: Pick<PaletteEntry, "info"> }) {
  const st = entry.info.style;
  return (
    <svg className="lse-swatch-svg" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill={st.fill ?? "#ffffff"} fillOpacity={st.fill ? st.opacity : 1}
        stroke={st.stroke ?? "rgb(0 0 0 / 0.25)"} strokeWidth="1" />
    </svg>
  );
}

/**
 * The "Kinds" panel (migration 0040): add a kind (e.g. "Sala" drawn as a building), rename / restyle / hide /
 * reorder any kind, delete a staff kind or put a built-in back as it ships. Drawn objects never change.
 */
export function PalettePanel({ e, palette, entryName, readOnly, onChange, confirm }: {
  e: E;
  palette: PaletteEntry[];
  entryName: (p: PaletteEntry) => string;
  readOnly: boolean;
  onChange: (rows: LandscapePaletteRowDto[]) => void;
  confirm: (message: string, label: string, run: () => void) => void;
}) {
  const p = e.palette;
  const [form, setForm] = useState<{ id: string | null; builtin: boolean; value: LandscapePaletteInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(run: () => Promise<LandscapePaletteRowDto[]>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await run());
      return true;
    } catch (err) {
      const fields = err instanceof ApiError ? Object.values(err.details ?? {}) : [];
      const code = err instanceof ApiError ? err.code : "";
      setError(p.errors[fields[0] ?? ""] ?? p.errors[code] ?? (err instanceof Error ? err.message : String(err)));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const save = (id: string | null, value: LandscapePaletteInput) => call(() => (id
    ? apiRequest<LandscapePaletteRowDto[]>("PUT", `/api/admin/landscape/palette/${encodeURIComponent(id)}`, value)
    : apiRequest<LandscapePaletteRowDto[]>("POST", "/api/admin/landscape/palette", value)));

  async function remove(entry: PaletteEntry) {
    if (entry.builtin) {
      confirm(format(p.resetConfirm, { name: entryName(entry) }), p.reset,
        () => void call(() => apiRequest<LandscapePaletteRowDto[]>("DELETE", `/api/admin/landscape/palette/${entry.id}`)));
      return;
    }
    const used = await apiGet<{ objects: number }>(`/api/admin/landscape/palette/${entry.id}/usage`).catch(() => ({ objects: 0 }));
    confirm(format(p.removeConfirm, { name: entryName(entry), n: used.objects }), p.remove,
      () => void call(() => apiRequest<LandscapePaletteRowDto[]>("DELETE", `/api/admin/landscape/palette/${entry.id}`)));
  }

  async function move(entry: PaletteEntry, dir: -1 | 1) {
    const swap = swapOrder(palette, entry.id, dir);
    if (!swap) return;
    for (const [en, order] of swap) {
      if (!(await save(en.id, { ...entryInput(en), sortOrder: order }))) return;
    }
  }

  const newKind = (): LandscapePaletteInput => {
    const base: LandscapeObjectKind = "BUILDING";
    const info = KIND_INFO[base];
    return { kind: base, name: "", draw: info.draw, fill: info.style.fill, stroke: info.style.stroke, opacity: info.style.opacity, layer: info.layer, size: info.size, group: "site", sortOrder: null, hidden: false, look: null };
  };

  if (form) {
    const v = form.value;
    const set = (patch: Partial<LandscapePaletteInput>) => setForm({ ...form, value: { ...v, ...patch } });
    return (
      <form className="lse-palette-form" onSubmit={(ev) => {
        ev.preventDefault();
        void save(form.id, { ...v, name: v.name?.trim() || null }).then((ok) => { if (ok) setForm(null); });
      }}>
        <h3 className="lse-cp__title">{form.id ? p.edit : p.add}</h3>
        {error && <p className="adm-field__error" role="alert">{error}</p>}
        <div className="adm-field">
          <label htmlFor="lsp-name">{p.name}</label>
          <input id="lsp-name" maxLength={LANDSCAPE_LIMITS.paletteName} required={!form.builtin} value={v.name ?? ""}
            placeholder={form.builtin ? e.kinds[v.kind] : ""} onChange={(ev) => set({ name: ev.target.value })} />
          {form.builtin && <p className="adm-field__hint">{p.nameBuiltinHint}</p>}
        </div>
        <div className="adm-field">
          <label htmlFor="lsp-kind">{p.base}</label>
          <select id="lsp-kind" disabled={form.builtin} value={v.kind} onChange={(ev) => {
            const kind = ev.target.value as LandscapeObjectKind;
            const info = KIND_INFO[kind];
            set({ kind, draw: info.draw, layer: info.layer, size: info.size, fill: info.style.fill, stroke: info.style.stroke, opacity: info.style.opacity, look: defaultLook(kind) });
          }}>
            {LANDSCAPE_OBJECT_KINDS.map((k) => <option key={k} value={k}>{e.kinds[k]}</option>)}
          </select>
          <p className="adm-field__hint">{RESERVABLE_KINDS.includes(v.kind) ? p.reservable : p.decorative}</p>
        </div>
        <LookPicker kind={v.kind} value={v.look} color={v.fill} accent={v.stroke} names={e.looks} flat={e.lookFlat} label={e.look} compact
          onPick={(look) => set({ look })} />
        <div className="adm-field">
          <label htmlFor="lsp-draw">{p.draw}</label>
          <select id="lsp-draw" value={v.draw} onChange={(ev) => set({ draw: ev.target.value as LandscapePaletteInput["draw"] })}>
            {SHAPE_TYPES.map((d) => <option key={d} value={d}>{p.draws[d]}</option>)}
          </select>
        </div>
        <div className="lse-grid2">
          <ColorField id="lsp-fill" label={e.fill} none={e.none} value={v.fill} onChange={(fill) => set({ fill })} />
          <ColorField id="lsp-stroke" label={e.stroke} none={e.none} value={v.stroke} onChange={(stroke) => set({ stroke })} />
        </div>
        <div className="adm-field">
          <label htmlFor="lsp-opacity">{e.opacity}: {Math.round(v.opacity * 100)}%</label>
          <input id="lsp-opacity" type="range" min={0.1} max={1} step={0.05} value={v.opacity} onChange={(ev) => set({ opacity: Number(ev.target.value) })} />
        </div>
        <div className="lse-grid2">
          <div className="adm-field">
            <label htmlFor="lsp-group">{p.group}</label>
            <select id="lsp-group" value={v.group} onChange={(ev) => set({ group: ev.target.value as LandscapePaletteInput["group"] })}>
              {PALETTE_GROUPS.map((g) => <option key={g} value={g}>{e.groups[g]}</option>)}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="lsp-layer">{p.layer}</label>
            <select id="lsp-layer" value={v.layer} onChange={(ev) => set({ layer: ev.target.value as LandscapePaletteInput["layer"] })}>
              {PALETTE_LAYERS.map((l) => <option key={l} value={l}>{p.layers[l]}</option>)}
            </select>
          </div>
        </div>
        <div className="adm-field">
          <label htmlFor="lsp-size">{p.size}</label>
          <input id="lsp-size" type="number" inputMode="decimal" min={0.2} max={50} step="any" value={Math.round(v.size * 1000) / 10}
            onChange={(ev) => { const n = Number(ev.target.value); if (Number.isFinite(n) && n >= 0.2 && n <= 50) set({ size: n / 100 }); }} />
          <p className="adm-field__hint">{p.sizeHint}</p>
        </div>
        <div className="lse-palette-form__actions">
          <Button type="submit" busy={busy} disabled={readOnly}>{p.save}</Button>
          <Button variant="ghost" onClick={() => { setForm(null); setError(null); }}>{p.cancel}</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="lse-palette">
      <p className="adm-small adm-muted">{p.hint}</p>
      {error && <p className="adm-field__error" role="alert">{error}</p>}
      <Button disabled={readOnly || busy} onClick={() => setForm({ id: null, builtin: false, value: newKind() })}>{p.add}</Button>
      {PALETTE_GROUPS.map((g) => {
        const list = palette.filter((x) => x.group === g);
        if (!list.length) return null;
        return (
          <section key={g} className="lse-palette__group" aria-label={e.groups[g]}>
            <h3 className="lse-cp__title">{e.groups[g]}</h3>
            <ul className="lse-palette__list">
              {list.map((x, i) => (
                <li key={x.id} className={`lse-palette__item${x.hidden ? " is-hidden" : ""}`}>
                  <span className="lse-palette__name">
                    <Swatch entry={x} /> {entryName(x)}
                    {!x.builtin && <span className="adm-badge adm-badge--muted">{p.custom} · {e.kinds[x.kind]}</span>}
                    {x.builtin && x.changed && <span className="adm-badge adm-badge--muted">{p.changed}</span>}
                    {x.hidden && <span className="adm-badge adm-badge--muted">{p.hiddenBadge}</span>}
                  </span>
                  <span className="lse-palette__actions">
                    <Button variant="ghost" disabled={readOnly || busy || i === 0} aria-label={`${p.up}: ${entryName(x)}`} onClick={() => void move(x, -1)}>↑</Button>
                    <Button variant="ghost" disabled={readOnly || busy || i === list.length - 1} aria-label={`${p.down}: ${entryName(x)}`} onClick={() => void move(x, 1)}>↓</Button>
                    <Button variant="secondary" disabled={readOnly || busy} aria-label={`${p.edit}: ${entryName(x)}`}
                      onClick={() => setForm({ id: x.id, builtin: x.builtin, value: { ...entryInput(x), name: x.name ?? "" } })}>{p.edit}</Button>
                    <Button variant="secondary" disabled={readOnly || busy} aria-label={`${x.hidden ? p.show : p.hide}: ${entryName(x)}`}
                      onClick={() => void save(x.id, { ...entryInput(x), hidden: !x.hidden })}>{x.hidden ? p.show : p.hide}</Button>
                    {(!x.builtin || x.changed) && (
                      <Button variant={x.builtin ? "ghost" : "danger"} disabled={readOnly || busy} aria-label={`${x.builtin ? p.reset : p.remove}: ${entryName(x)}`}
                        onClick={() => void remove(x)}>{x.builtin ? p.reset : p.remove}</Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ColorField({ id, label, none, value, onChange }: { id: string; label: string; none: string; value: string | null; onChange: (v: string | null) => void }) {
  const [last, setLast] = useState(value ?? "#cccccc");
  return (
    <div className="adm-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="color" disabled={value === null} value={value ?? last} onChange={(ev) => { setLast(ev.target.value); onChange(ev.target.value); }} />
      <label className="adm-check adm-small">
        <input type="checkbox" checked={value === null} onChange={(ev) => onChange(ev.target.checked ? null : last)} /> {none}
      </label>
    </div>
  );
}
