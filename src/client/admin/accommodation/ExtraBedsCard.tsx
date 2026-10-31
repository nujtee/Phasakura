import { useEffect, useState, type FormEvent } from "react";
import type { AdminUnitDto } from "../../../shared/accommodation-types.ts";
import type { ExtraBedSettingsDto } from "../../../shared/booking-types.ts";
import { MAX_EXTRA_BEDS_PER_UNIT } from "../../../shared/booking-types.ts";
import { SATANG_PER_BAHT, formatBaht, parseBahtToSatang } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, Field, fieldErrors } from "../ui.tsx";

/**
 * Extra beds (migration 0043): on / off, price per bed per night, beds per house / VIP tent. The guest adds them on
 * the booking page (food step); bookings already made keep the price they were made at.
 * Houses can be switched on / off one by one, or all at once (migration 0047).
 */
export function ExtraBedsCard() {
  const { t, can, locale } = useAdmin();
  const [s, setS] = useState<ExtraBedSettingsDto | null>(null);
  const [f, setF] = useState({ enabled: false, price: "0", max: "1" });
  const [units, setUnits] = useState<AdminUnitDto[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("accommodation.edit");

  const show = (x: ExtraBedSettingsDto) => {
    setS(x);
    setF({ enabled: x.enabled, price: String(x.pricePerNightSatang / SATANG_PER_BAHT), max: String(x.maxPerUnit) });
    setOff(new Set(x.offUnitIds ?? []));
  };

  useEffect(() => {
    const controller = new AbortController();
    apiGet<ExtraBedSettingsDto>("/api/admin/extra-beds", controller.signal)
      .then(show)
      .catch((err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: errorMessage(t, err) }));
    // Every house / VIP tent (not deleted) for the per-house switches.
    apiGet<AdminUnitDto[]>("/api/admin/accommodations", controller.signal)
      .then((list) => setUnits(list.filter((u) => u.status !== "DELETED" && (u.unitType === "HOUSE" || u.unitType === "VIP_TENT"))))
      .catch(() => undefined);
    return () => controller.abort();
  }, [t]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const price = parseBahtToSatang(f.price || "0");
    if (price === null) return setErrors({ pricePerNightSatang: t.errors.INVALID_PRICE });
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      show(await apiRequest<ExtraBedSettingsDto>("PUT", "/api/admin/extra-beds", {
        enabled: f.enabled, pricePerNightSatang: price, maxPerUnit: Number(f.max),
        offUnitIds: [...off].filter((id) => units.some((u) => u.id === id)),
      }));
      setMessage({ kind: "success", text: t.acc.extraBedsSaved });
      setOpen(false);
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  if (!s) return message ? <Alert kind="error">{message.text}</Alert> : null;
  const offSaved = units.filter((u) => (s.offUnitIds ?? []).includes(u.id)).length;
  const state = s.enabled
    ? format(t.acc.extraBedsOn, { price: formatBaht(s.pricePerNightSatang, locale.code), max: s.maxPerUnit })
      + (units.length ? ` · ${format(t.acc.extraBedsUnitsCount, { on: units.length - offSaved, total: units.length })}` : "")
    : t.acc.extraBedsOff;
  const toggle = (id: string, on: boolean) => setOff((prev) => {
    const next = new Set(prev);
    if (on) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="adm-card adm-extrabeds" aria-labelledby="extra-beds-h">
      <div className="adm-extrabeds__head">
        <div>
          <h2 className="adm-h2" id="extra-beds-h">{t.acc.extraBedsTitle}</h2>
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
              <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
              {t.acc.extraBedsEnabled}
            </label>
            <div className="adm-grid2">
              <Field label={t.acc.extraBedsPrice} inputMode="decimal" value={f.price} disabled={!can("pricing.edit")}
                hint={!can("pricing.edit") ? t.acc.needsPricing : t.acc.extraBedsPriceHint}
                onChange={(e) => setF({ ...f, price: e.target.value })} error={errors.pricePerNightSatang} />
              <Field label={t.acc.extraBedsMax} type="number" min={1} max={MAX_EXTRA_BEDS_PER_UNIT} value={f.max}
                onChange={(e) => setF({ ...f, max: e.target.value })} error={errors.maxPerUnit} />
            </div>
            {units.length > 0 && (
              <fieldset className="adm-fieldset adm-extrabeds__units" disabled={!f.enabled}>
                <legend className="adm-label">{t.acc.extraBedsUnits}</legend>
                <div className="adm-row">
                  <Button variant="ghost" onClick={() => setOff(new Set())}>{t.acc.extraBedsAllOn}</Button>
                  <Button variant="ghost" onClick={() => setOff(new Set(units.map((u) => u.id)))}>{t.acc.extraBedsAllOff}</Button>
                </div>
                <ul className="adm-extrabeds__unitlist">
                  {units.map((u) => (
                    <li key={u.id}>
                      <label className="adm-check">
                        <input type="checkbox" checked={!off.has(u.id)} onChange={(e) => toggle(u.id, e.target.checked)} />
                        {u.unitCode} — {u.translations[locale.code]?.name ?? u.translations.th?.name ?? ""}
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="adm-field__hint">{t.acc.extraBedsUnitsHint}</p>
              </fieldset>
            )}
            <p className="adm-field__hint">{t.acc.extraBedsHint}</p>
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
