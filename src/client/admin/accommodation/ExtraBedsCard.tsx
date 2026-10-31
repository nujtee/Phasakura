import { useEffect, useState, type FormEvent } from "react";
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
 */
export function ExtraBedsCard() {
  const { t, can, locale } = useAdmin();
  const [s, setS] = useState<ExtraBedSettingsDto | null>(null);
  const [f, setF] = useState({ enabled: false, price: "0", max: "1" });
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("accommodation.edit");

  const show = (x: ExtraBedSettingsDto) => {
    setS(x);
    setF({ enabled: x.enabled, price: String(x.pricePerNightSatang / SATANG_PER_BAHT), max: String(x.maxPerUnit) });
  };

  useEffect(() => {
    const controller = new AbortController();
    apiGet<ExtraBedSettingsDto>("/api/admin/extra-beds", controller.signal)
      .then(show)
      .catch((err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: errorMessage(t, err) }));
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
  const state = s.enabled
    ? format(t.acc.extraBedsOn, { price: formatBaht(s.pricePerNightSatang, locale.code), max: s.maxPerUnit })
    : t.acc.extraBedsOff;

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
