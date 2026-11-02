import { useEffect, useState, type FormEvent } from "react";
import type { AdminUnitDto } from "../../../shared/accommodation-types.ts";
import { MAX_PROMO_TEXT, type FoodMenuDto, type PricingRuleDto, type PricingRuleInput, type PricingTargetType } from "../../../shared/booking-types.ts";
import { formatBaht, parseBahtToSatang, PAY_NOW_PERCENTS, SATANG_PER_BAHT } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { unitName } from "../accommodation/UnitsPage.tsx";
import { Alert, Button, Field, fieldErrors } from "../ui.tsx";
import { useStayDate } from "./shared.tsx";
import { PromotionPerks } from "./PromotionPerks.tsx";

const EMPTY: PricingRuleInput = {
  targetType: "UNIT_TYPE", unitId: null, unitType: "HOUSE", name: "", dateFrom: "", dateTo: "",
  daysOfWeek: "0123456", priceSatang: 0, priority: 0, status: "ACTIVE", payNowPercent: null,
  discountKind: null, discountValue: null, freeExtraBed: false, freePets: false, freeFoodOptionIds: [], promoText: null, perkIds: [],
};

type Editing = { id: string | null; input: PricingRuleInput; price: string; discount: string };

/** The discount as typed: percent as is, an amount in baht. */
const discountText = (r: PricingRuleInput) =>
  r.discountKind === "PERCENT" ? String(r.discountValue ?? "") : r.discountKind === "AMOUNT" && r.discountValue ? String(r.discountValue / SATANG_PER_BAHT) : "";

/** Seasonal / weekday price rules. Viewing needs accommodation.view; saving needs pricing.edit (enforced by the Worker). */
export function PricingRulesPage() {
  const { t, can, locale } = useAdmin();
  const stayDate = useStayDate();
  const [rules, setRules] = useState<PricingRuleDto[] | null>(null);
  const [units, setUnits] = useState<AdminUnitDto[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [foods, setFoods] = useState<FoodMenuDto["categories"]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const days = t.pricing.dayNames.split(",");
  const editable = can("pricing.edit");

  const load = () => apiGet<PricingRuleDto[]>("/api/admin/pricing-rules").then(setRules).catch(() => setMessage({ kind: "error", text: t.errors.UNKNOWN }));
  useEffect(() => {
    void load();
    apiGet<AdminUnitDto[]>("/api/admin/accommodations").then(setUnits).catch(() => undefined);
    // Dishes a promotion can give for free (active menu, in the admin's language).
    apiGet<FoodMenuDto>(`/api/public/food-menu?lang=${locale.code}`).then((m) => setFoods(m.categories)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = (id: string) => { const u = units.find((x) => x.id === id); return u ? unitName(u, locale.code, u.unitCode) : id; };
  const targetLabel = (r: PricingRuleInput) =>
    r.targetType === "UNITS" ? (r.unitIds ?? []).map(nameOf).join(", ")
      : r.targetType === "UNIT" ? (units.find((u) => u.id === r.unitId) ? unitName(units.find((u) => u.id === r.unitId)!, locale.code, "") : r.unitId)
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
    const kind = editing.input.discountKind ?? null;
    let discountValue: number | null = null;
    if (kind === "PERCENT") discountValue = Number(editing.discount);
    if (kind === "AMOUNT") discountValue = parseBahtToSatang(editing.discount);
    if (kind && (discountValue === null || !Number.isInteger(discountValue) || discountValue < 1)) {
      setErrors({ discountValue: kind === "PERCENT" ? t.errors.PERCENT_RANGE : t.errors.AMOUNT_RANGE });
      return;
    }
    const body = { ...editing.input, priceSatang, discountKind: kind, discountValue, promoText: editing.input.promoText?.trim() || null };
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

  const promoSummary = (r: PricingRuleDto) => [
    r.discountKind === "PERCENT" ? format(t.pricing.promoOff, { v: r.discountValue ?? 0 }) : null,
    r.discountKind === "AMOUNT" ? format(t.pricing.promoBaht, { v: formatBaht(r.discountValue ?? 0, locale.code) }) : null,
    r.freeExtraBed ? t.pricing.promoBed : null,
    r.freePets ? t.pricing.promoPet : null,
    r.freeFoodOptionIds?.length ? format(t.pricing.promoFood, { n: r.freeFoodOptionIds.length }) : null,
    r.perkIds?.length ? format(t.pricing.promoPerks, { n: r.perkIds.length }) : null,
    r.promoText ? `“${r.promoText}”` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{t.pricing.title}</h1>
        {editable && !editing && (
          <Button onClick={() => { setEditing({ id: null, input: EMPTY, price: "", discount: "" }); setErrors({}); }}>+ {t.pricing.newRule}</Button>
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
                {/* A group stays a group; a single rule stays single (a new group rule is made instead). */}
                {(editing.id ? (editing.input.targetType === "UNITS" ? ["UNITS"] as const : ["UNIT", "UNIT_TYPE", "CAMPING"] as const)
                  : ["UNIT", "UNITS", "UNIT_TYPE", "CAMPING"] as const).map((x) => <option key={x} value={x}>{t.pricing[`target${x}`]}</option>)}
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
          {editing.input.targetType === "UNITS" && (
            <fieldset className="adm-fieldset adm-ruleunits" aria-invalid={errors.unitIds ? true : undefined}>
              <legend className="adm-label">{t.pricing.units}</legend>
              <div className="adm-row">
                <Button variant="ghost" onClick={() => set({ unitIds: units.filter((u) => u.status !== "DELETED").map((u) => u.id) })}>{t.pricing.allUnits}</Button>
                <Button variant="ghost" onClick={() => set({ unitIds: [] })}>{t.pricing.noUnits}</Button>
              </div>
              <ul className="adm-extrabeds__unitlist">
                {units.filter((u) => u.status !== "DELETED").map((u) => {
                  const chosen = editing.input.unitIds ?? [];
                  return (
                    <li key={u.id}>
                      <label className="adm-check">
                        <input type="checkbox" checked={chosen.includes(u.id)}
                          onChange={(e) => set({ unitIds: e.target.checked ? [...chosen, u.id] : chosen.filter((x) => x !== u.id) })} />
                        {u.unitCode} · {unitName(u, locale.code, "")}
                      </label>
                    </li>
                  );
                })}
              </ul>
              {errors.unitIds && <p className="adm-field__error">{errors.unitIds}</p>}
            </fieldset>
          )}
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
            <label htmlFor="pr-paynow">{t.pricing.payNow}</label>
            <select id="pr-paynow" value={editing.input.payNowPercent === null ? "" : String(editing.input.payNowPercent)}
              aria-describedby="pr-paynow-hint" onChange={(e) => set({ payNowPercent: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t.pricing.payNowPlan}</option>
              {PAY_NOW_PERCENTS.map((p) => <option key={p} value={p}>{p === 100 ? t.pricing.payNowFull : format(t.pricing.payNowPercent, { p })}</option>)}
            </select>
            <p className="adm-field__hint" id="pr-paynow-hint">{t.pricing.payNowHint}</p>
            {errors.payNowPercent && <p className="adm-field__error">{errors.payNowPercent}</p>}
          </div>
          <PromotionFields editing={editing} setEditing={setEditing} foods={foods} errors={errors} />
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
                <th scope="col" className="adm-num">{t.pricing.payNowColumn}</th>
                <th scope="col">{t.pricing.promoColumn}</th>
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
                  <td className="adm-num">{r.payNowPercent === null ? <span className="adm-muted adm-small">{t.pricing.payNowPlanShort}</span> : `${r.payNowPercent}%`}</td>
                  <td className="adm-small">{promoSummary(r) || <span className="adm-muted">{t.pricing.promoNone}</span>}</td>
                  <td className="adm-num">{r.priority}</td>
                  <td><span className={`adm-badge adm-badge--${r.status === "ACTIVE" ? "active" : "deleted"}`}>{r.status === "ACTIVE" ? t.pricing.active : t.pricing.inactive}</span></td>
                  {editable && (
                    <td>
                      <Button variant="ghost" onClick={() => {
                        const { id, updatedAt: _u, ...input } = r;
                        setEditing({ id, input, price: String(r.priceSatang / SATANG_PER_BAHT), discount: discountText(input) });
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

/** Promotion of a price rule (migration 0055): room discount, free extra bed / pets / dishes, a text for guests. */
function PromotionFields({ editing, setEditing, foods, errors }: {
  editing: Editing; setEditing: (e: Editing) => void; foods: FoodMenuDto["categories"]; errors: Record<string, string>;
}) {
  const { t, locale } = useAdmin();
  const input = editing.input;
  const set = (patch: Partial<PricingRuleInput>, discount = editing.discount) => setEditing({ ...editing, input: { ...input, ...patch }, discount });
  const chosen = input.freeFoodOptionIds ?? [];
  const price = parseBahtToSatang(editing.price);
  const value = input.discountKind === "PERCENT" ? Number(editing.discount) : input.discountKind === "AMOUNT" ? parseBahtToSatang(editing.discount) : null;
  const after = price !== null && value ? (input.discountKind === "PERCENT"
    ? Math.round((price * (100 - Math.min(value, 100))) / 100 / SATANG_PER_BAHT) * SATANG_PER_BAHT : Math.max(0, price - value)) : null;
  return (
    <fieldset className="adm-fieldset adm-promo">
      <legend className="adm-label">{t.pricing.promo}</legend>
      <p className="adm-field__hint">{t.pricing.promoHint}</p>
      <div className="adm-grid2">
        <div className="adm-field">
          <label htmlFor="pr-disc-kind">{t.pricing.discount}</label>
          <select id="pr-disc-kind" value={input.discountKind ?? ""}
            onChange={(e) => set({ discountKind: (e.target.value || null) as PricingRuleInput["discountKind"], discountValue: null }, "")}>
            <option value="">{t.pricing.discountNone}</option>
            <option value="PERCENT">{t.pricing.discountPercent}</option>
            <option value="AMOUNT">{t.pricing.discountAmount}</option>
          </select>
          {errors.discountKind && <p className="adm-field__error">{errors.discountKind}</p>}
        </div>
        {input.discountKind && (
          <Field label={input.discountKind === "PERCENT" ? t.pricing.discountValuePercent : t.pricing.discountValueAmount} required
            inputMode={input.discountKind === "PERCENT" ? "numeric" : "decimal"} value={editing.discount} error={errors.discountValue}
            hint={after !== null ? format(t.pricing.discountPreview, { price: formatBaht(after, locale.code) }) : undefined}
            onChange={(e) => setEditing({ ...editing, discount: e.target.value })} />
        )}
      </div>
      <div className="adm-row adm-promo__checks">
        <label className="adm-check">
          <input type="checkbox" checked={!!input.freeExtraBed} onChange={(e) => set({ freeExtraBed: e.target.checked })} />
          {t.pricing.freeExtraBed}
        </label>
        <label className="adm-check">
          <input type="checkbox" checked={!!input.freePets} onChange={(e) => set({ freePets: e.target.checked })} />
          {t.pricing.freePets}
        </label>
      </div>
      <fieldset className="adm-fieldset adm-promo__foods">
        <legend className="adm-label">{t.pricing.freeFoods}</legend>
        {!foods.some((c) => c.options.length) && <p className="adm-muted adm-small">{t.pricing.freeFoodsNone}</p>}
        {foods.filter((c) => c.options.length).map((c) => (
          <div key={c.id} className="adm-promo__foodgroup">
            <p className="adm-small adm-muted">{c.name}</p>
            <ul className="adm-extrabeds__unitlist">
              {c.options.map((o) => (
                <li key={o.id}>
                  <label className="adm-check">
                    <input type="checkbox" checked={chosen.includes(o.id)}
                      onChange={(e) => set({ freeFoodOptionIds: e.target.checked ? [...chosen, o.id] : chosen.filter((x) => x !== o.id) })} />
                    {o.name} <span className="adm-muted">· {formatBaht(o.priceSatang, locale.code)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {errors.freeFoodOptionIds && <p className="adm-field__error">{errors.freeFoodOptionIds}</p>}
      </fieldset>
      <PromotionPerks selected={input.perkIds ?? []} onChange={(ids) => set({ perkIds: ids })} editable />
      <div className="adm-field">
        <label htmlFor="pr-promo-text">{t.pricing.promoText}</label>
        <textarea id="pr-promo-text" rows={2} maxLength={MAX_PROMO_TEXT} value={input.promoText ?? ""} aria-describedby="pr-promo-text-hint"
          onChange={(e) => set({ promoText: e.target.value })} />
        <p className="adm-field__hint" id="pr-promo-text-hint">{t.pricing.promoTextHint}</p>
        {errors.promoText && <p className="adm-field__error">{errors.promoText}</p>}
      </div>
    </fieldset>
  );
}
