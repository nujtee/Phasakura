import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PromotionPerkDto } from "../../../shared/booking-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, Field } from "../ui.tsx";

type Names = Record<LocaleCode, string>;
const NO_NAMES: Names = { th: "", en: "", "zh-CN": "" };
const clean = (n: Names) => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v.trim()] as const).filter(([, v]) => v));

/**
 * Extra perks of a promotion (migration 0056): a shared list like the amenities — tick the ones this rule gives,
 * add new ones, rename (✎) or delete (🗑) an item. The ticks are saved with the rule; the list itself is saved at once.
 */
export function PromotionPerks({ selected, onChange, editable }: { selected: string[]; onChange: (ids: string[]) => void; editable: boolean }) {
  const { t, locale } = useAdmin();
  const [all, setAll] = useState<PromotionPerkDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [nw, setNw] = useState<Names>(NO_NAMES);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; names: Names } | null>(null);
  const [deleting, setDeleting] = useState<PromotionPerkDto | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const nameOf = (p: { names: Partial<Record<string, string>> }) => p.names[locale.code] ?? p.names.th ?? "";

  useEffect(() => {
    apiGet<PromotionPerkDto[]>("/api/admin/promotion-perks").then(setAll).catch(() => undefined);
  }, []);
  useEffect(() => { if (adding) addRef.current?.querySelector("input")?.focus(); }, [adding]);
  useEffect(() => { if (editing) editRef.current?.querySelector("input")?.focus(); }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Not a <form>: this sits inside the price-rule form (Enter in a field adds / saves the item, not the rule).
  const onEnter = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); fn(); } };

  async function create(e?: FormEvent) {
    e?.preventDefault();
    const names = clean(nw);
    if (!names.th) { setNotice({ kind: "error", text: t.errors.DEFAULT_LANGUAGE_REQUIRED }); return; }
    setBusy(true);
    setNotice(null);
    try {
      const made = await apiRequest<PromotionPerkDto>("POST", "/api/admin/promotion-perks", { names });
      setAll((a) => [...a, made]);
      onChange([...selected, made.id]);
      setNw(NO_NAMES);
      setNotice({ kind: "success", text: format(t.pricing.perkAdded, { name: names.th }) });
      addRef.current?.querySelector("input")?.focus();
    } catch (err) {
      setNotice({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    const names = clean(editing.names);
    if (!names.th) { setNotice({ kind: "error", text: t.errors.DEFAULT_LANGUAGE_REQUIRED }); return; }
    setBusy(true);
    setNotice(null);
    try {
      const updated = await apiRequest<PromotionPerkDto>("PATCH", `/api/admin/promotion-perks/${encodeURIComponent(editing.id)}`, { names });
      setAll((a) => a.map((x) => (x.id === updated.id ? updated : x)));
      setEditing(null);
      setNotice({ kind: "success", text: format(t.pricing.perkUpdated, { name: names.th }) });
    } catch (err) {
      setNotice({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: PromotionPerkDto) {
    setDeleting(null);
    setNotice(null);
    try {
      await apiRequest("DELETE", `/api/admin/promotion-perks/${encodeURIComponent(p.id)}`);
      setAll((a) => a.filter((x) => x.id !== p.id));
      onChange(selected.filter((x) => x !== p.id));
      if (editing?.id === p.id) setEditing(null);
      setNotice({ kind: "success", text: format(t.pricing.perkDeleted, { name: nameOf(p) }) });
    } catch (err) {
      setNotice({ kind: "error", text: detailMessage(t, err) });
    }
  }

  return (
    <fieldset className="adm-fieldset adm-promo__perks">
      <legend className="adm-label">{t.pricing.perks}</legend>
      <p className="adm-field__hint">{t.pricing.perksHint}</p>
      <div className="adm-amenities">
        {all.map((p) => (
          <div key={p.id} className="adm-amenity">
            <label className="adm-check">
              <input type="checkbox" checked={selected.includes(p.id)} disabled={!editable}
                onChange={(e) => onChange(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
              {nameOf(p)}
            </label>
            {editable && (
              <span className="adm-amenity__actions">
                <button type="button" className="adm-amenity__btn" aria-label={`${t.pricing.perkEdit}: ${nameOf(p)}`} title={t.pricing.perkEdit}
                  onClick={() => { setAdding(false); setEditing({ id: p.id, names: { th: p.names.th ?? "", en: p.names.en ?? "", "zh-CN": p.names["zh-CN"] ?? "" } }); }}>
                  ✎
                </button>
                <button type="button" className="adm-amenity__btn adm-amenity__btn--danger" aria-label={`${t.pricing.perkDelete}: ${nameOf(p)}`} title={t.pricing.perkDelete}
                  onClick={() => setDeleting(p)}>
                  🗑
                </button>
              </span>
            )}
          </div>
        ))}
        {all.length === 0 && <p className="adm-muted adm-small">{t.pricing.perksNone}</p>}
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {editable && editing && (
        <div ref={editRef} className="adm-subform" role="group" aria-label={t.pricing.perkEdit}>
          <div className="adm-grid2">
            {LOCALES.map((l) => (
              <Field key={l.code} label={`${t.pricing.perkName} (${l.label})${l.code === "th" ? " *" : ""}`} lang={l.code} maxLength={80}
                value={editing.names[l.code]} onKeyDown={onEnter(() => void saveEdit())}
                onChange={(e) => setEditing({ ...editing, names: { ...editing.names, [l.code]: e.target.value } })} />
            ))}
          </div>
          <div className="adm-row adm-row--wrap">
            <Button onClick={() => void saveEdit()} busy={busy}>{t.pricing.perkSave}</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
          </div>
        </div>
      )}
      {editable && !adding && (
        <Button variant="ghost" onClick={() => { setEditing(null); setAdding(true); setNotice(null); }}>+ {t.pricing.perkNew}</Button>
      )}
      {editable && adding && (
        <div ref={addRef} className="adm-subform" role="group" aria-label={t.pricing.perkNew}>
          <div className="adm-grid2">
            {LOCALES.map((l) => (
              <Field key={l.code} label={`${t.pricing.perkName} (${l.label})${l.code === "th" ? " *" : ""}`} lang={l.code} maxLength={80}
                value={nw[l.code]} placeholder={l.code === "th" ? t.pricing.perkExample : undefined} onKeyDown={onEnter(() => void create())}
                onChange={(e) => setNw({ ...nw, [l.code]: e.target.value })} />
            ))}
          </div>
          <div className="adm-row adm-row--wrap">
            <Button onClick={() => void create()} busy={busy}>{t.pricing.perkAdd}</Button>
            <Button variant="ghost" onClick={() => { setAdding(false); setNw(NO_NAMES); }}>{t.common.close}</Button>
          </div>
        </div>
      )}
      <ConfirmDialog open={deleting !== null} danger confirmLabel={t.pricing.perkDelete}
        message={deleting ? format(t.pricing.perkDeleteConfirm, { name: nameOf(deleting), n: deleting.ruleCount }) : ""}
        onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void remove(deleting); }} />
    </fieldset>
  );
}
