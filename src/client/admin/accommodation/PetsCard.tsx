import { useEffect, useState, type FormEvent } from "react";
import type { PetChargePer, PetSettingsDto } from "../../../shared/booking-types.ts";
import { MAX_PET_WEIGHT_KG, MAX_PETS_PER_UNIT } from "../../../shared/booking-types.ts";
import { SATANG_PER_BAHT, formatBaht, parseBahtToSatang } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, Field, fieldErrors } from "../ui.tsx";

/**
 * Pets (migration 0044): on / off on its own, price per pet (per night or per stay), heaviest pet allowed and pets per
 * house / VIP tent. The guest adds them on the booking page (add-ons step); bookings already made keep their price.
 */
export function PetsCard() {
  const { t, can, locale } = useAdmin();
  const [s, setS] = useState<PetSettingsDto | null>(null);
  const [f, setF] = useState({ enabled: false, price: "0", chargePer: "NIGHT" as PetChargePer, kg: "10", max: "2" });
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("accommodation.edit");

  const show = (x: PetSettingsDto) => {
    setS(x);
    setF({ enabled: x.enabled, price: String(x.priceSatang / SATANG_PER_BAHT), chargePer: x.chargePer, kg: String(x.maxWeightKg), max: String(x.maxPerUnit) });
  };

  useEffect(() => {
    const controller = new AbortController();
    apiGet<PetSettingsDto>("/api/admin/pets", controller.signal)
      .then(show)
      .catch((err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: errorMessage(t, err) }));
    return () => controller.abort();
  }, [t]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const price = parseBahtToSatang(f.price || "0");
    if (price === null) return setErrors({ priceSatang: t.errors.INVALID_PRICE });
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      show(await apiRequest<PetSettingsDto>("PUT", "/api/admin/pets", {
        enabled: f.enabled, priceSatang: price, chargePer: f.chargePer, maxWeightKg: Number(f.kg), maxPerUnit: Number(f.max),
      }));
      setMessage({ kind: "success", text: t.acc.petsSaved });
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
    ? format(s.chargePer === "STAY" ? t.acc.petsOnStay : t.acc.petsOnNight, { price: formatBaht(s.priceSatang, locale.code), kg: s.maxWeightKg, max: s.maxPerUnit })
    : t.acc.petsOff;

  return (
    <section className="adm-card adm-extrabeds adm-pets" aria-labelledby="pets-h">
      <div className="adm-extrabeds__head">
        <div>
          <h2 className="adm-h2" id="pets-h">{t.acc.petsTitle}</h2>
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
              {t.acc.petsEnabled}
            </label>
            <div className="adm-grid2">
              <Field label={t.acc.petsPrice} inputMode="decimal" value={f.price} disabled={!can("pricing.edit")}
                hint={!can("pricing.edit") ? t.acc.needsPricing : t.acc.extraBedsPriceHint}
                onChange={(e) => setF({ ...f, price: e.target.value })} error={errors.priceSatang} />
              <div className="adm-field">
                <label htmlFor="pets-charge">{t.acc.petsChargePer}</label>
                <select id="pets-charge" value={f.chargePer} disabled={!can("pricing.edit")}
                  onChange={(e) => setF({ ...f, chargePer: e.target.value as PetChargePer })}>
                  <option value="NIGHT">{t.acc.petsPerNight}</option>
                  <option value="STAY">{t.acc.petsPerStay}</option>
                </select>
                {errors.chargePer && <p className="adm-field__error">{errors.chargePer}</p>}
              </div>
              <Field label={t.acc.petsMaxWeight} type="number" min={1} max={MAX_PET_WEIGHT_KG} value={f.kg}
                onChange={(e) => setF({ ...f, kg: e.target.value })} error={errors.maxWeightKg} />
              <Field label={t.acc.petsMax} type="number" min={1} max={MAX_PETS_PER_UNIT} value={f.max}
                onChange={(e) => setF({ ...f, max: e.target.value })} error={errors.maxPerUnit} />
            </div>
            <p className="adm-field__hint">{t.acc.petsHint}</p>
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
