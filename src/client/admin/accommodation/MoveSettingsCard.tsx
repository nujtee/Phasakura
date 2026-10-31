import { useEffect, useState, type FormEvent } from "react";
import type { MoveSettingsDto } from "../../../shared/booking-types.ts";
import { SATANG_PER_BAHT, formatBaht, parseBahtToSatang } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, Field, fieldErrors } from "../ui.tsx";

/**
 * Guests change their own dates from the booking page (migration 0045): on / off, the fee, how close to the check-in,
 * how many times, how long the new nights are held while the guest transfers.
 */
export function MoveSettingsCard() {
  const { t, can, locale } = useAdmin();
  const [s, setS] = useState<MoveSettingsDto | null>(null);
  const [f, setF] = useState({ enabled: false, fee: "0", days: "3", max: "1", minutes: "60" });
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("bookings.edit");

  const show = (x: MoveSettingsDto) => {
    setS(x);
    setF({ enabled: x.enabled, fee: String(x.feeSatang / SATANG_PER_BAHT), days: String(x.minDaysBefore), max: String(x.maxMoves), minutes: String(x.payMinutes) });
  };

  useEffect(() => {
    if (!can("bookings.view")) return;
    const controller = new AbortController();
    apiGet<MoveSettingsDto>("/api/admin/move-settings", controller.signal)
      .then(show)
      .catch((err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: errorMessage(t, err) }));
    return () => controller.abort();
  }, [t, can]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const fee = parseBahtToSatang(f.fee || "0");
    if (fee === null) return setErrors({ feeSatang: t.errors.INVALID_PRICE });
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      show(await apiRequest<MoveSettingsDto>("PUT", "/api/admin/move-settings", {
        enabled: f.enabled, feeSatang: fee, minDaysBefore: Number(f.days), maxMoves: Number(f.max), payMinutes: Number(f.minutes),
      }));
      setMessage({ kind: "success", text: t.acc.moveSaved });
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
    ? format(t.acc.moveOn, { fee: formatBaht(s.feeSatang, locale.code), days: s.minDaysBefore, max: s.maxMoves, minutes: s.payMinutes })
    : t.acc.moveOff;

  return (
    <section className="adm-card adm-extrabeds adm-movesettings" aria-labelledby="move-settings-h">
      <div className="adm-extrabeds__head">
        <div>
          <h2 className="adm-h2" id="move-settings-h">{t.acc.moveTitle}</h2>
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
              {t.acc.moveEnabled}
            </label>
            <div className="adm-grid2">
              <Field label={t.acc.moveFeeLabel} inputMode="decimal" value={f.fee} disabled={!can("pricing.edit")}
                hint={!can("pricing.edit") ? t.acc.needsPricing : t.acc.extraBedsPriceHint}
                onChange={(e) => setF({ ...f, fee: e.target.value })} error={errors.feeSatang} />
              <Field label={t.acc.moveDays} type="number" min={0} max={365} value={f.days}
                onChange={(e) => setF({ ...f, days: e.target.value })} error={errors.minDaysBefore} />
              <Field label={t.acc.moveMax} type="number" min={1} max={10} value={f.max}
                onChange={(e) => setF({ ...f, max: e.target.value })} error={errors.maxMoves} />
              <Field label={t.acc.movePay} type="number" min={15} max={1440} value={f.minutes}
                onChange={(e) => setF({ ...f, minutes: e.target.value })} error={errors.payMinutes} />
            </div>
            <p className="adm-field__hint">{t.acc.moveHint}</p>
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
