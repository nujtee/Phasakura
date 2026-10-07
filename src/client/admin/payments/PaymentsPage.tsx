import { useCallback, useState, type FormEvent } from "react";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { PAYMENT_STATUSES_ALL } from "../../../shared/booking-types.ts";
import type { AdminPaymentListItemDto } from "../../../shared/dashboard-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { PAYMENT_METHODS } from "../../../shared/payment-types.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { PaymentBadge } from "../bookings/shared.tsx";
import { Alert, Button, useDateFormatter } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";

/** All payments (spec §26), newest first. Slip images open only through the authenticated slip endpoint. */
export function PaymentsPage() {
  const { t, c, href, locale, can } = useAdmin();
  const dateTime = useDateFormatter();
  const [draft, setDraft] = useState({ status: "", method: "", code: "", from: "", to: "" });
  const [filters, setFilters] = useState(draft);

  const buildUrl = useCallback((before: string | null) => {
    const params = new URLSearchParams({ limit: "50" });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, k === "code" ? v.trim().toUpperCase() : v);
    if (before) params.set("before", before);
    return `/api/admin/payments?${params}`;
  }, [filters]);
  const { items, cursor, loading, error, more } = useCursorList<AdminPaymentListItemDto>(buildUrl);
  const baht = (n: number) => formatBaht(n, locale.code);
  const methodLabel = (m: string) => (c.payList as Record<string, string>)[`method${m}`] ?? m;

  return (
    <section>
      <h1 className="adm-h1">{c.payList.title}</h1>
      <form className="adm-filters" onSubmit={(e: FormEvent) => { e.preventDefault(); setFilters(draft); }}>
        <label className="adm-filter"><span>{t.bk.payment}</span>
          <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.currentTarget.value })}>
            <option value="">{c.ui.all}</option>
            {PAYMENT_STATUSES_ALL.map((s) => <option key={s} value={s}>{t.bk[`p${s}`]}</option>)}
          </select>
        </label>
        <label className="adm-filter"><span>{c.payList.method}</span>
          <select value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.currentTarget.value })}>
            <option value="">{c.ui.all}</option>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
          </select>
        </label>
        <label className="adm-filter"><span>{c.ui.from}</span>
          <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.currentTarget.value })} /></label>
        <label className="adm-filter"><span>{c.ui.to}</span>
          <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.currentTarget.value })} /></label>
        <label className="adm-filter adm-filter--grow"><span>{c.payList.searchCode}</span>
          <input type="search" placeholder="BK-YYYYMMDD-XXXX" maxLength={20} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.currentTarget.value })} /></label>
        <Button type="submit" variant="secondary">{t.common.search}</Button>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{c.payList.booking}</th>
              <th scope="col" className="adm-num">{c.payList.amount}</th>
              <th scope="col">{c.payList.method}</th>
              <th scope="col">{t.bk.status}</th>
              <th scope="col">{c.payList.submitted}</th>
              <th scope="col">{c.payList.reference}</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && <tr><td colSpan={6} className="adm-table__empty">{c.payList.empty}</td></tr>}
            {items.map((p) => (
              <tr key={p.id}>
                <td><Link to={href("bookings", p.bookingCode)} className="adm-table__primary adm-mono">{p.bookingCode}</Link></td>
                <td className="adm-num">
                  {baht(p.amountSatang)}
                  {p.refundAmountSatang !== null && <div className="adm-small adm-muted">{format(c.payList.refunded, { amount: baht(p.refundAmountSatang) })}</div>}
                </td>
                <td>{methodLabel(p.method)}{p.hasSlip && can("slips.view") && <> · <Link to={href("slips")}>{c.payList.slip}</Link></>}</td>
                <td><PaymentBadge status={p.status} /></td>
                <td className="adm-small">
                  {dateTime(p.submittedAt)}
                  {p.paidAt && <div className="adm-muted">{c.payList.paidAt}: {dateTime(p.paidAt)}</div>}
                  {p.verifiedAt && <div className="adm-muted">{c.payList.verifiedAt}: {dateTime(p.verifiedAt)}</div>}
                </td>
                <td className="adm-small adm-mono">{p.reference ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && <div className="adm-pager"><Button variant="secondary" busy={loading} onClick={more}>{t.common.loadMore}</Button></div>}
    </section>
  );
}
