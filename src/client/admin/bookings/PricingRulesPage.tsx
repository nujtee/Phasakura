import { useEffect, useState, type FormEvent } from "react";
import type { AdminUnitDto } from "../../../shared/accommodation-types.ts";
import type { PricingRuleDto, PricingRuleInput, PricingTargetType } from "../../../shared/booking-types.ts";
import { formatBaht, parseBahtToSatang, SATANG_PER_BAHT } from "../../../shared/booking-rules.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { unitName } from "../accommodation/UnitsPage.tsx";
import { Alert, Button, Field, fieldErrors } from "../ui.tsx";
import { useStayDate } from "./shared.tsx";

const EMPTY: PricingRuleInput = {
  targetType: "UNIT_TYPE", unitId: null, unitType: "HOUSE", name: "", dateFrom: "", dateTo: "",
  daysOfWeek: "0123456", priceSatang: 0, priority: 0, status: "ACTIVE",
};

/** Seasonal / weekday price rules. Viewing needs accommodation.view; saving needs pricing.edit (enforced by the Worker). */
export function PricingRulesPage() {
  const { t, can, locale } = useAdmin();
  const stayDate = useStayDate();
  const [rules, setRules] = useState<PricingRuleDto[] | null>(null);
  const [units, setUnits] = useState<AdminUnitDto[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; input: PricingRuleInput; price: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const days = t.pricing.dayNames.split(",");
  const editable = can("pricing.edit");

  const load = () => apiGet<PricingRuleDto[]>("/api/admin/pricing-rules").then(setRules).catch(() => setMessage({ kind: "error", text: t.errors.UNKNOWN }));
  useEffect(() => {
    void load();
    apiGet<AdminUnitDto[]>("/api/admin/accommodations").then(setUnits).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targetLabel = (r: PricingRuleInput) =>
    r.targetType === "UNIT" ? (units.find((u) => u.id === r.unitId) ? unitName(units.find((u) => u.id === r.unitId)!, locale.code, "") : r.unitId)
      : r.targetType === "UNIT_TYPE" ? `${t.pricing.targetUNIT_TYPE}: ${r.unitType === "HOUSE" ? t.nav.houses : t.nav.vipTents}`
        : t.pricing.targetCAMPING;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const priceSatang = parseBahtToSatang(editing.price);
    if (priceSatang === null) {
      setErrors({ priceSatang: t.errors.INVALID_PRICE });
      return;
    }
    const body = { ...editing.input, priceSatang };
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      if (editing.id) await apiRequest("PATCH", `/api/admin/pricing-rules/${encodeURIComponent(editing.id)}`, body);
      else await apiRequest("POST", "/api/admin/pricing-rules", body);
      setEditing(null);
      setMessage({ kind: "success", text: t.common.saved });
      await load();
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage({ kind: "error", text: t.errors.VALIDATION_FAILED });
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<PricingRuleInput>) => editing && setEditing({ ...editing, input: { ...editing.input, ...patch } });
  const toggleDay = (d: number) => {
    if (!editing) return;
    const current = new Set(editing.input.daysOfWeek.split(""));
    if (current.has(String(d))) current.delete(String(d));
    else current.add(String(d));
    set({ daysOfWeek: [...current].sort().join("") });
  };

  return (
    <section>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{t.pricing.title}</h1>
        {editable && !editing && (
          <Button onClick={() => { setEditing({ id: null, input: EMPTY, price: "" }); setErrors({}); }}>+ {t.pricing.newRule}</Button>
        )}
      </div>
      <p className="adm-muted">{t.pricing.intro}</p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      {editing && (
        <form className="adm-card" onSubmit={(e) => void save(e)}>
          <h2 className="adm-h2">{editing.id ? t.pricing.edit : t.pricing.newRule}</h2>
          <div className="adm-grid2">
            <div className="adm-field">
              <label htmlFor="pr-target">{t.pricing.target}</label>
              <select id="pr-target" value={editing.input.targetType}
                onChange={(e) => set({ targetType: e.target.value as PricingTargetType })}>
                {(["UNIT", "UNIT_TYPE", "CAMPING"] as const).map((x) => <option key={x} value={x}>{t.pricing[`target${x}`]}</option>)}
              </select>
            </div>
            {editing.input.targetType === "UNIT" && (
              <div className="adm-field">
                <label htmlFor="pr-unit">{t.bk.item}</label>
                <select id="pr-unit" required value={editing.input.unitId ?? ""} onChange={(e) => set({ unitId: e.target.value || null })}
                  aria-invalid={errors.unitId ? true : undefined}>
                  <option value="">—</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.unitCode} · {unitName(u, locale.code, "")}</option>)}
                </select>
                {errors.unitId && <p className="adm-field__error">{errors.unitId}</p>}
              </div>
            )}
            {editing.input.targetType === "UNIT_TYPE" && (
              <div className="adm-field">
                <label htmlFor="pr-type">{t.pricing.unitType}</label>
                <select id="pr-type" value={editing.input.unitType ?? "HOUSE"} onChange={(e) => set({ unitType: e.target.value as "HOUSE" | "VIP_TENT" })}>
                  <option value="HOUSE">{t.nav.houses}</option>
                  <option value="VIP_TENT">{t.nav.vipTents}</option>
                </select>
              </div>
            )}
          </div>
          <Field label={t.pricing.name} required maxLength={80} value={editing.input.name} error={errors.name}
            onChange={(e) => set({ name: e.target.value })} />
          <div className="adm-grid2">
            <Field label={t.pricing.dateFrom} type="date" required value={editing.input.dateFrom} error={errors.dateFrom}
              onChange={(e) => set({ dateFrom: e.target.value })} />
            <Field label={t.pricing.dateTo} type="date" required min={editing.input.dateFrom || undefined} value={editing.input.dateTo}
              error={errors.dateTo} onChange={(e) => set({ dateTo: e.target.value })} />
          </div>
          <fieldset className="adm-days">
            <legend>{t.pricing.days}</legend>
            {days.map((label, d) => (
              <label key={label} className="adm-day">
                <input type="checkbox" checked={editing.input.daysOfWeek.includes(String(d))} onChange={() => toggleDay(d)} />
                <span>{label}</span>
              </label>
            ))}
            {errors.daysOfWeek && <p className="adm-field__error">{errors.daysOfWeek}</p>}
          </fieldset>
          <div className="adm-grid2">
            <Field label={t.pricing.price} required inputMode="decimal" value={editing.price} error={errors.priceSatang}
              onChange={(e) => setEditing({ ...editing, price: e.target.value })} />
            <Field label={t.pricing.priority} type="number" min={-1000} max={1000} value={String(editing.input.priority)}
              hint={t.pricing.priorityHint} error={errors.priority} onChange={(e) => set({ priority: Number(e.target.value) || 0 })} />
          </div>
          <div className="adm-field">
            <label htmlFor="pr-status">{t.pricing.status}</label>
            <select id="pr-status" value={editing.input.status} onChange={(e) => set({ status: e.target.value as "ACTIVE" | "INACTIVE" })}>
              <option value="ACTIVE">{t.pricing.active}</option>
              <option value="INACTIVE">{t.pricing.inactive}</option>
            </select>
          </div>
          <div className="adm-row">
            <Button type="submit" busy={busy}>{busy ? t.common.saving : t.common.save}</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
          </div>
        </form>
      )}

      {!rules && <p role="status">{t.common.loading}</p>}
      {rules && rules.length === 0 && <p className="adm-empty">{t.pricing.empty}</p>}
      {rules && rules.length > 0 && (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{t.pricing.name}</th>
                <th scope="col">{t.pricing.target}</th>
                <th scope="col">{t.pricing.dateFrom}</th>
                <th scope="col">{t.pricing.days}</th>
                <th scope="col" className="adm-num">{t.pricing.price}</th>
                <th scope="col" className="adm-num">{t.pricing.priority}</th>
                <th scope="col">{t.pricing.status}</th>
                {editable && <th scope="col"><span className="visually-hidden">{t.pricing.edit}</span></th>}
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="adm-table__primary">{r.name}</td>
                  <td className="adm-small">{targetLabel(r)}</td>
                  <td className="adm-small">{stayDate(r.dateFrom)} → {stayDate(r.dateTo)}</td>
                  <td className="adm-small">{r.daysOfWeek === "0123456" ? "—" : r.daysOfWeek.split("").map((d) => days[Number(d)]).join(" ")}</td>
                  <td className="adm-num">{formatBaht(r.priceSatang, locale.code)}</td>
                  <td className="adm-num">{r.priority}</td>
                  <td><span className={`adm-badge adm-badge--${r.status === "ACTIVE" ? "active" : "deleted"}`}>{r.status === "ACTIVE" ? t.pricing.active : t.pricing.inactive}</span></td>
                  {editable && (
                    <td>
                      <Button variant="ghost" onClick={() => {
                        const { id, updatedAt: _u, ...input } = r;
                        setEditing({ id, input, price: String(r.priceSatang / SATANG_PER_BAHT) });
                        setErrors({});
                        window.scrollTo({ top: 0 });
                      }}>{t.pricing.edit}</Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
