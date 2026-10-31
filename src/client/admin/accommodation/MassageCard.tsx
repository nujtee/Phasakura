import { useEffect, useState, type FormEvent } from "react";
import type { MassageAdminItemDto, MassageSettingsDto } from "../../../shared/booking-types.ts";
import { SATANG_PER_BAHT, formatBaht, parseBahtToSatang } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, fieldErrors } from "../ui.tsx";

interface DraftOption { id: string; minutes: string; price: string }
interface DraftItem { id: string; nameTh: string; nameEn: string; active: boolean; options: DraftOption[] }

const toDraft = (items: MassageAdminItemDto[]): DraftItem[] => items.map((i) => ({
  id: i.id, nameTh: i.nameTh, nameEn: i.nameEn ?? "", active: i.active,
  options: i.options.map((o) => ({ id: o.id, minutes: String(o.minutes), price: String(o.priceSatang / SATANG_PER_BAHT) })),
}));

/**
 * Health massage (migration 0050): off by default. The owner switches it on and edits the menu — treatments, their
 * lengths (minutes) and prices. Guests pick them on the booking page ("รายการเพิ่มเติม"); bookings keep their price.
 */
export function MassageCard() {
  const { t, can, locale } = useAdmin();
  const [s, setS] = useState<MassageSettingsDto | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("accommodation.edit");
  const canPrice = can("pricing.edit");

  const show = (x: MassageSettingsDto) => {
    setS(x);
    setEnabled(x.enabled);
    setItems(toDraft(x.items));
  };

  useEffect(() => {
    const controller = new AbortController();
    apiGet<MassageSettingsDto>("/api/admin/massage", controller.signal)
      .then(show)
      .catch((err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: errorMessage(t, err) }));
    return () => controller.abort();
  }, [t]);

  const patchItem = (i: number, patch: Partial<DraftItem>) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const patchOption = (i: number, k: number, patch: Partial<DraftOption>) =>
    patchItem(i, { options: items[i]!.options.map((o, j) => (j === k ? { ...o, ...patch } : o)) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad: Record<string, string> = {};
    const body = items.map((it, i) => ({
      ...(it.id ? { id: it.id } : {}),
      nameTh: it.nameTh.trim(),
      nameEn: it.nameEn.trim() || null,
      active: it.active,
      options: it.options.map((o, k) => {
        const priceSatang = parseBahtToSatang(o.price || "0");
        if (priceSatang === null) bad[`items.${i}.options.${k}.priceSatang`] = t.errors.INVALID_PRICE;
        return { ...(o.id ? { id: o.id } : {}), minutes: Number(o.minutes), priceSatang: priceSatang ?? 0 };
      }),
    }));
    if (Object.keys(bad).length) return setErrors(bad);
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      show(await apiRequest<MassageSettingsDto>("PUT", "/api/admin/massage", { enabled, items: body }));
      setMessage({ kind: "success", text: t.acc.massageSaved });
      setOpen(false);
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  if (!s) return message ? <Alert kind="error">{message.text}</Alert> : null;
  const listed = s.items.filter((i) => i.active && i.options.length);
  const prices = listed.flatMap((i) => i.options.map((o) => o.priceSatang));
  const state = s.enabled
    ? format(t.acc.massageOn, {
      n: listed.length,
      from: prices.length ? formatBaht(Math.min(...prices), locale.code) : "—",
    })
    : t.acc.massageOff;
  const err = (k: string) => errors[k];

  return (
    <section className="adm-card adm-extrabeds adm-massage" aria-labelledby="massage-h">
      <div className="adm-extrabeds__head">
        <div>
          <h2 className="adm-h2" id="massage-h">{t.acc.massageTitle}</h2>
          <p className="adm-small adm-muted">
            <span className={`adm-badge ${s.enabled ? "adm-badge--active" : "adm-badge--deleted"}`}>{s.enabled ? t.acc.extraBedsBadgeOn : t.acc.extraBedsBadgeOff}</span>{" "}
            {state}
          </p>
        </div>
        {canEdit && !open && <Button variant="secondary" onClick={() => setOpen(true)}>{t.acc.extraBedsEdit}</Button>}
      </div>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {open && (
        <form onSubmit={submit} noValidate>
          <fieldset className="adm-fieldset" disabled={!canEdit || busy}>
            <label className="adm-check">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {t.acc.massageEnabled}
            </label>
            {err("items") && <p className="adm-field__error">{err("items")}</p>}
            <ol className="adm-massage__list">
              {items.map((it, i) => (
                <li key={it.id || `new-${i}`} className="adm-massage__item">
                  <div className="adm-grid2">
                    <div className="adm-field">
                      <label htmlFor={`m-th-${i}`}>{t.acc.massageNameTh}</label>
                      <input id={`m-th-${i}`} value={it.nameTh} maxLength={120} required aria-invalid={err(`items.${i}.nameTh`) ? true : undefined}
                        onChange={(e) => patchItem(i, { nameTh: e.target.value })} />
                      {err(`items.${i}.nameTh`) && <p className="adm-field__error">{err(`items.${i}.nameTh`)}</p>}
                    </div>
                    <div className="adm-field">
                      <label htmlFor={`m-en-${i}`}>{t.acc.massageNameEn}</label>
                      <input id={`m-en-${i}`} value={it.nameEn} maxLength={120} onChange={(e) => patchItem(i, { nameEn: e.target.value })} />
                    </div>
                  </div>
                  <div className="adm-massage__options">
                    {it.options.map((o, k) => (
                      <div key={o.id || `o-${k}`} className="adm-massage__option">
                        <label className="adm-massage__mini">
                          <span>{t.acc.massageMinutes}</span>
                          <input type="number" min={10} max={480} step={5} value={o.minutes} aria-invalid={err(`items.${i}.options.${k}.minutes`) ? true : undefined}
                            onChange={(e) => patchOption(i, k, { minutes: e.target.value })} />
                        </label>
                        <label className="adm-massage__mini">
                          <span>{t.acc.massagePrice}</span>
                          <input inputMode="decimal" value={o.price} disabled={!canPrice} aria-invalid={err(`items.${i}.options.${k}.priceSatang`) ? true : undefined}
                            onChange={(e) => patchOption(i, k, { price: e.target.value })} />
                        </label>
                        {it.options.length > 1 && (
                          <button type="button" className="adm-linkbtn adm-linkbtn--danger" aria-label={`${t.acc.massageRemoveTime} ${o.minutes}`}
                            onClick={() => patchItem(i, { options: it.options.filter((_, j) => j !== k) })}>{t.acc.massageRemoveTime}</button>
                        )}
                        {(err(`items.${i}.options.${k}.minutes`) || err(`items.${i}.options.${k}.priceSatang`)) && (
                          <p className="adm-field__error">{err(`items.${i}.options.${k}.minutes`) ?? err(`items.${i}.options.${k}.priceSatang`)}</p>
                        )}
                      </div>
                    ))}
                    {it.options.length < 6 && (
                      <Button variant="ghost" onClick={() => patchItem(i, { options: [...it.options, { id: "", minutes: "90", price: "0" }] })}>
                        + {t.acc.massageAddTime}
                      </Button>
                    )}
                  </div>
                  <div className="adm-row">
                    <label className="adm-check">
                      <input type="checkbox" checked={it.active} onChange={(e) => patchItem(i, { active: e.target.checked })} />
                      {t.acc.massageActive}
                    </label>
                    <button type="button" className="adm-linkbtn" disabled={i === 0}
                      onClick={() => setItems((cur) => { const n = [...cur]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; return n; })}>↑ {t.acc.massageUp}</button>
                    <button type="button" className="adm-linkbtn adm-linkbtn--danger" onClick={() => setItems((cur) => cur.filter((_, j) => j !== i))}>
                      {t.acc.massageRemove}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <Button variant="secondary" onClick={() => setItems((cur) => [...cur, { id: "", nameTh: "", nameEn: "", active: true, options: [{ id: "", minutes: "60", price: "0" }] }])}>
              + {t.acc.massageAdd}
            </Button>
            {!canPrice && <p className="adm-field__hint">{t.acc.needsPricing}</p>}
            <p className="adm-field__hint">{t.acc.massageHint}</p>
          </fieldset>
          <div className="adm-row">
            <Button type="submit" busy={busy} disabled={!canEdit}>{busy ? t.common.saving : t.common.save}</Button>
            <Button variant="secondary" onClick={() => { setOpen(false); show(s); setErrors({}); }}>{t.common.cancel}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
