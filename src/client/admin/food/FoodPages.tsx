import { useCallback, useEffect, useState } from "react";
import type { AdminUnitDto } from "../../../shared/accommodation-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { addDays } from "../../../shared/dates.ts";
import {
  FOOD_ORDER_FLOW, FOOD_ORDER_STATUSES, type FoodCapacityDto, type FoodCategoryRefDto, type FoodOrderDto, type FoodOrderStatus,
} from "../../../shared/food-admin-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import type { LocaleCode } from "../../../shared/i18n/locales.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { CmsManager, enumLabel, PageTabs } from "../cms/CmsKit.tsx";
import { useOptions } from "../content/ContentPages.tsx";
import { Alert, Button, detailMessage } from "../ui.tsx";

function catName(cat: FoodCategoryRefDto | undefined, lang: LocaleCode): string {
  return cat ? cat.names[lang] ?? cat.names.th ?? cat.code : "";
}

/** Food menu (spec §19–23): dishes, categories, included meals and daily capacity. */
export function FoodMenuPage() {
  const { c, locale, can } = useAdmin();
  const [tab, setTab] = useState<"options" | "categories" | "included" | "capacity">("options");
  const [category, setCategory] = useState("");
  const categories = useOptions("foodCategory");
  const options = useOptions("foodOption");
  const [units, setUnits] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    if (!can("accommodation.view")) return;
    Promise.all(["HOUSE", "VIP_TENT"].map((type) => apiGet<AdminUnitDto[]>(`/api/admin/accommodations?type=${type}`)))
      .then((lists) => setUnits(lists.flat().map((u) => ({
        value: u.id, label: u.translations[locale.code]?.name ?? u.translations.th?.name ?? u.unitCode,
      }))))
      .catch(() => setUnits([]));
  }, [can, locale.code]);

  const label = (list: { value: string; label: string }[], id: unknown) => list.find((o) => o.value === id)?.label ?? String(id ?? "");

  return (
    <section>
      <h1 className="adm-h1">{c.food.title}</h1>
      <PageTabs label={c.food.title} value={tab} onChange={(v) => { setTab(v); void categories.reload(); void options.reload(); }}
        tabs={[
          { value: "options", label: c.food.options }, { value: "categories", label: c.food.categories },
          { value: "included", label: c.food.included }, { value: "capacity", label: c.food.capacity },
        ]} />
      {tab === "options" && (
        <CmsManager key={`options-${category}`} entity="foodOption" newLabel={c.food.newOption}
          query={category ? `foodCategoryId=${encodeURIComponent(category)}` : ""}
          presets={category ? { foodCategoryId: category } : {}}
          refOptions={{ foodCategoryId: categories.options }}
          summary={(r) => `${label(categories.options, r.foodCategoryId)} · ${formatBaht(r.priceSatang as number, locale.code)} ${enumLabel(c, "pricingType", r.pricingType as string)} · ${c.fields.childPricing}: ${enumLabel(c, "childPricing", r.childPricing as string)}`}
          toolbar={() => (
            <label className="adm-field adm-field--inline">
              <span>{c.food.categoryOf}</span>
              <select value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
                <option value="">{c.ui.all}</option>
                {categories.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )} />
      )}
      {tab === "categories" && (
        <CmsManager key="categories" entity="foodCategory" newLabel={c.food.newCategory}
          summary={(r) => [
            r.code as string,
            r.defaultDailyCapacity == null ? c.food.unlimited : `${c.food.limit} ${r.defaultDailyCapacity as number}`,
            enumLabel(c, "deadlineType", r.deadlineType as string),
            r.serviceTime ? `${c.fields.serviceTime} ${r.serviceTime as string}` : "",
          ].filter(Boolean).join(" · ")} />
      )}
      {tab === "included" && (
        <CmsManager key="included" entity="includedMeal" newLabel={c.food.newIncluded}
          refOptions={{ unitId: units, foodCategoryId: categories.options, foodOptionId: options.options }}
          summary={(r) => [
            `${c.food.target}: ${r.targetType === "UNIT" ? label(units, r.unitId) : r.targetType === "UNIT_TYPE" ? enumLabel(c, "unitType", r.unitType as string) : enumLabel(c, "targetType", "CAMPING")}`,
            `${label(categories.options, r.foodCategoryId)} (${r.foodOptionId ? label(options.options, r.foodOptionId) : c.food.anyOption})`,
            format(c.food.perNight, { n: r.personsPerNight as number }),
            enumLabel(c, "status", r.status as string),
          ].join(" · ")} />
      )}
      {tab === "capacity" && <CapacityGrid />}
    </section>
  );
}

/** Daily limit per meal category (spec §22): used / max, per-day override. */
function CapacityGrid() {
  const { t, c, can, locale } = useAdmin();
  const [from, setFrom] = useState<string | null>(null);
  const [data, setData] = useState<FoodCapacityDto | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [edit, setEdit] = useState<{ categoryId: string; date: string; value: string } | null>(null);
  const canEdit = can("food.edit");

  const load = useCallback(async (start: string | null) => {
    try {
      const q = start ? `?from=${start}&to=${addDays(start, 14)}` : "";
      setData(await apiGet<FoodCapacityDto>(`/api/admin/food/capacity${q}`));
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    }
  }, [t]);
  useEffect(() => { void load(from); }, [from, load]);

  async function save(max: number | null) {
    if (!edit) return;
    setMessage(null);
    try {
      await apiRequest("PUT", `/api/admin/food/capacity/${encodeURIComponent(edit.categoryId)}/${edit.date}`, { maxQuantity: max });
      setEdit(null);
      setMessage({ kind: "success", text: t.common.saved });
      await load(from ?? data?.from ?? null);
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    }
  }

  if (!data) return message ? <Alert kind={message.kind}>{message.text}</Alert> : <p role="status">{t.common.loading}</p>;
  const dayFmt = new Intl.DateTimeFormat(locale.code, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const limited = data.categories.filter((cat) => cat.status === "ACTIVE");
  return (
    <div>
      <div className="adm-toolbar">
        <div className="adm-row">
          <Button variant="secondary" onClick={() => setFrom(addDays(data.from, -14))}>← {c.ui.previous}</Button>
          <Button variant="secondary" onClick={() => setFrom(null)}>{c.ui.today}</Button>
          <Button variant="secondary" onClick={() => setFrom(addDays(data.from, 14))}>{c.ui.next} →</Button>
        </div>
      </div>
      <p className="adm-field__hint">{c.food.capacityHint}</p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table adm-captable">
          <thead>
            <tr>
              <th scope="col">{c.food.categoryOf}</th>
              {data.dates.map((d) => <th key={d} scope="col" className="adm-nowrap">{dayFmt.format(new Date(`${d}T00:00:00Z`))}</th>)}
            </tr>
          </thead>
          <tbody>
            {limited.map((cat) => (
              <tr key={cat.id}>
                <th scope="row">{catName(cat, locale.code)}</th>
                {data.dates.map((d) => {
                  const cell = data.cells.find((x) => x.categoryId === cat.id && x.date === d)!;
                  const full = cell.max !== null && cell.used >= cell.max;
                  return (
                    <td key={d} className={`adm-capcell${cell.overridden ? " adm-capcell--override" : ""}${full ? " adm-capcell--full" : ""}`}>
                      {cell.max === null ? (
                        <span className="adm-small">{cell.used}/∞</span>
                      ) : canEdit ? (
                        <button type="button" className="adm-linkbtn" aria-label={`${catName(cat, locale.code)} ${d}: ${cell.used}/${cell.max}`}
                          onClick={() => setEdit({ categoryId: cat.id, date: d, value: String(cell.max) })}>
                          {cell.used}/{cell.max}
                        </button>
                      ) : <span>{cell.used}/{cell.max}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <form className="adm-card adm-row adm-row--wrap" onSubmit={(e) => { e.preventDefault(); void save(Number(edit.value)); }}>
          <label className="adm-field adm-field--inline">
            <span>{catName(data.categories.find((x) => x.id === edit.categoryId), locale.code)} · {edit.date} — {c.food.limit}</span>
            <input type="number" min={0} max={100000} value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.currentTarget.value })} />
          </label>
          <Button type="submit">{t.common.save}</Button>
          <Button variant="secondary" onClick={() => void save(null)}>{c.food.resetDefault}</Button>
          <Button variant="ghost" onClick={() => setEdit(null)}>{t.common.cancel}</Button>
        </form>
      )}
    </div>
  );
}

/** Kitchen orders (spec §24): per service day, forward-only status, kitchen note. */
export function FoodOrdersPage() {
  const { t, c, can, href, locale } = useAdmin();
  const [date, setDate] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{ from: string; categories: FoodCategoryRefDto[]; orders: FoodOrderDto[] } | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const manage = can("food_orders.manage");

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (date) { q.set("from", date); q.set("to", addDays(date, 1)); }
      if (status) q.set("status", status);
      const res = await apiGet<{ from: string; categories: FoodCategoryRefDto[]; orders: FoodOrderDto[] }>(`/api/admin/food-orders?${q.toString()}`);
      setData(res);
      setNotes(Object.fromEntries(res.orders.map((o) => [o.id, o.kitchenNote ?? ""])));
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    }
  }, [date, status, t]);
  useEffect(() => { void load(); }, [load]);

  async function update(o: FoodOrderDto, next: FoodOrderStatus, note?: string) {
    setMessage(null);
    try {
      await apiRequest("PATCH", `/api/admin/food-orders/${o.id}`, { status: next, expectedStatus: o.status, ...(note !== undefined ? { kitchenNote: note || null } : {}) });
      setMessage({ kind: "success", text: t.common.saved });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    }
  }

  const sLabel = (s: string) => (c.orders as Record<string, string>)[`s${s}`] ?? s;
  const day = data?.from ?? date ?? "";
  const grouped = (data?.categories ?? []).map((cat) => ({ cat, orders: (data?.orders ?? []).filter((o) => o.categoryId === cat.id) })).filter((g) => g.orders.length);

  return (
    <section>
      <h1 className="adm-h1">{c.orders.title}</h1>
      <div className="adm-filters">
        <label className="adm-field adm-field--inline">
          <span>{c.orders.date}</span>
          <input type="date" value={day} onChange={(e) => setDate(e.currentTarget.value || null)} />
        </label>
        <Button variant="secondary" onClick={() => day && setDate(addDays(day, -1))}>←</Button>
        <Button variant="secondary" onClick={() => setDate(null)}>{c.ui.today}</Button>
        <Button variant="secondary" onClick={() => day && setDate(addDays(day, 1))}>→</Button>
        <label className="adm-field adm-field--inline">
          <span>{c.orders.status}</span>
          <select value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            <option value="">{c.ui.all}</option>
            {FOOD_ORDER_STATUSES.map((s) => <option key={s} value={s}>{sLabel(s)}</option>)}
          </select>
        </label>
      </div>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {!data && !message && <p role="status">{t.common.loading}</p>}
      {data && grouped.length === 0 && <div className="adm-empty">{c.orders.empty}</div>}
      {grouped.map(({ cat, orders }) => (
        <div key={cat.id} className="adm-card">
          <h2 className="adm-h2">
            {catName(cat, locale.code)}{cat.serviceTime ? ` · ${cat.serviceTime}` : ""}
            {" — "}{format(c.orders.persons, { n: orders.filter((o) => o.status !== "CANCELLED").reduce((a, o) => a + o.totalPersons, 0) })}
          </h2>
          <ul className="adm-orders">
            {orders.map((o) => {
              const idx = FOOD_ORDER_FLOW.indexOf(o.status);
              const next = idx >= 0 && idx < FOOD_ORDER_FLOW.length - 1 ? FOOD_ORDER_FLOW[idx + 1]! : null;
              const paid = ["CONFIRMED", "CHECKED_IN", "CHECKED_OUT"].includes(o.bookingStatus);
              return (
                <li key={o.id} className={`adm-order adm-order--${o.status.toLowerCase()}`}>
                  <div className="adm-order__head">
                    <Link to={href("bookings", o.bookingCode)} className="adm-mono">{o.bookingCode}</Link>
                    <span className={`adm-badge adm-badge--${o.status === "CANCELLED" ? "deleted" : o.status === "SERVED" ? "muted" : "active"}`}>{sLabel(o.status)}</span>
                    {o.customerName && <span>{o.customerName}</span>}
                    {o.itemName && <span className="adm-muted">{o.itemName}</span>}
                  </div>
                  <ul className="adm-small">
                    {o.lines.map((l, i) => (
                      <li key={i} className={l.cancelled ? "adm-muted" : ""}>
                        {l.name} × {l.quantity}
                        {l.includedQuantity > 0 && ` (${format(c.orders.included, { n: l.includedQuantity })})`}
                        {l.cancelled && ` — ${c.orders.cancelledLine}`}
                      </li>
                    ))}
                  </ul>
                  {!paid && o.status !== "CANCELLED" && <p className="adm-small adm-text-error">{c.orders.unpaid}</p>}
                  {manage && o.status !== "CANCELLED" && (
                    <div className="adm-row adm-row--wrap">
                      {next && <Button disabled={!paid} onClick={() => update(o, next)}>{format(c.orders.next, { status: sLabel(next) })}</Button>}
                      <label className="adm-field adm-field--inline adm-filter--grow">
                        <span className="adm-sr">{c.orders.note}</span>
                        <input type="text" maxLength={500} placeholder={c.orders.note} value={notes[o.id] ?? ""}
                          onChange={(e) => { const v = e.currentTarget.value; setNotes((n) => ({ ...n, [o.id]: v })); }} />
                      </label>
                      <Button variant="secondary" disabled={(notes[o.id] ?? "") === (o.kitchenNote ?? "")} onClick={() => update(o, o.status, notes[o.id] ?? "")}>{c.orders.saveNote}</Button>
                    </div>
                  )}
                  {!manage && o.kitchenNote && <p className="adm-small">{c.orders.note}: {o.kitchenNote}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
