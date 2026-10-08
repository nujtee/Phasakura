import { useEffect, useState } from "react";
import type { AdminBookingDto } from "../../../shared/booking-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getLineMessages } from "../../../shared/i18n/admin-line-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, errorMessage, useDateFormatter } from "../ui.tsx";
import { PaymentPanel } from "../payments/PaymentPanel.tsx";
import { BookingStatusBadge, useStayDate } from "./shared.tsx";

type StayAction = "check-in" | "check-out" | "no-show";

export function BookingDetailPage({ code }: { code: string }) {
  const { t, c, can, href, locale } = useAdmin();
  const [stayAction, setStayAction] = useState<StayAction | null>(null);
  const [stayDone, setStayDone] = useState(false);
  const dateTime = useDateFormatter();
  const stayDate = useStayDate();
  const [b, setB] = useState<AdminBookingDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<AdminBookingDto>(`/api/admin/bookings/${encodeURIComponent(code)}`, controller.signal)
      .then(setB)
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [code, t, version]);

  async function cancel() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      setB(await apiRequest<AdminBookingDto>("POST", `/api/admin/bookings/${encodeURIComponent(code)}/cancel`, { reason: reason.trim() }));
      setDone(true);
    } catch (err) {
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function stay(action: StayAction) {
    setStayAction(null);
    setBusy(true);
    setError(null);
    setStayDone(false);
    try {
      setB(await apiRequest<AdminBookingDto>("POST", `/api/admin/bookings/${encodeURIComponent(code)}/stay/${action}`));
      setStayDone(true);
    } catch (err) {
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  const baht = (s: number) => formatBaht(s, locale.code);
  const back = <p><Link to={href("bookings")}>← {t.bk.back}</Link></p>;
  if (!b) return <section>{back}{error ? <Alert kind="error">{error}</Alert> : <p role="status">{t.common.loading}</p>}</section>;

  const cancellable = (b.status === "PENDING" || b.status === "CONFIRMED") && can("bookings.cancel");
  const extraFood = b.food.filter((f) => f.includedQuantity === 0);
  const includedFood = b.food.filter((f) => f.includedQuantity > 0);

  return (
    <section>
      {back}
      <div className="adm-pagehead">
        <h1 className="adm-h1 adm-mono">{b.bookingCode}</h1>
        <BookingStatusBadge status={b.status} />
      </div>
      {done && <Alert kind="success">{t.bk.cancelled}</Alert>}
      {stayDone && <Alert kind="success">{c.stay.done}</Alert>}
      {can("bookings.edit") && (b.status === "CONFIRMED" || b.status === "CHECKED_IN") && (
        <div className="adm-card">
          <h2 className="adm-h2">{c.stay.title}</h2>
          <div className="adm-row adm-row--wrap">
            {b.status === "CONFIRMED" && <Button busy={busy} onClick={() => setStayAction("check-in")}>{c.stay.checkIn}</Button>}
            {b.status === "CHECKED_IN" && <Button busy={busy} onClick={() => setStayAction("check-out")}>{c.stay.checkOut}</Button>}
            {b.status === "CONFIRMED" && <Button variant="secondary" busy={busy} onClick={() => setStayAction("no-show")}>{c.stay.noShow}</Button>}
          </div>
          <ConfirmDialog open={!!stayAction} danger={stayAction === "no-show"}
            message={stayAction === "check-in" ? c.stay.confirmCheckIn : stayAction === "check-out" ? c.stay.confirmCheckOut : c.stay.confirmNoShow}
            confirmLabel={stayAction === "check-in" ? c.stay.checkIn : stayAction === "check-out" ? c.stay.checkOut : c.stay.noShow}
            onConfirm={() => stayAction && void stay(stayAction)} onCancel={() => setStayAction(null)} />
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}

      <div className="adm-grid2">
        <div className="adm-card">
          <h2 className="adm-h2">{t.bk.stay}</h2>
          <dl className="adm-dl">
            <dt>{t.bk.item}</dt><dd>{b.item.name}{b.item.type === "OWN_TENT" && ` · ${format(t.bk.tents, { n: b.item.quantity })}`}{b.tarp && ` + ${t.bk.tarp}`}</dd>
            <dt>{t.bk.stay}</dt><dd>{stayDate(b.checkIn)} → {stayDate(b.checkOut)} ({format(t.bk.nights, { n: b.nights })})</dd>
            <dt>{t.bk.guest}</dt><dd>{format(t.bk.guests, { adults: b.adults, children: b.children })}</dd>
            <dt>{t.bk.payment}</dt><dd>{t.bk[`p${b.paymentStatus}`]}</dd>
            {b.status === "PENDING" && b.expiresAt && <><dt>{t.bk.expires}</dt><dd>{dateTime(b.expiresAt)}</dd></>}
            <dt>{t.bk.created}</dt><dd>{dateTime(b.createdAt)} · {b.source} · {b.languageCode}</dd>
            {b.cancelledAt && <><dt>{t.bk.cancelledAt}</dt><dd>{dateTime(b.cancelledAt)}</dd><dt>{t.bk.cancelReason}</dt><dd>{b.cancelReason}</dd></>}
          </dl>
        </div>
        <div className="adm-card">
          <h2 className="adm-h2">{t.bk.customer}</h2>
          <dl className="adm-dl">
            <dt>{t.users.name}</dt><dd>{b.customerName}</dd>
            <dt>{t.bk.phone}</dt><dd><a href={`tel:${b.customerPhone.replace(/[^\d+]/g, "")}`}>{b.customerPhone}</a></dd>
            {b.customerEmail && <><dt>{t.bk.email}</dt><dd>{b.customerEmail}</dd></>}
            {b.customerLineId && <><dt>{t.bk.lineId}</dt><dd>{b.customerLineId}</dd></>}
            {b.lineUpdates.linked && <><dt>LINE</dt><dd><span className="adm-badge adm-badge--active">✓ {getLineMessages(locale.code).bookingLinked}</span></dd></>}
            {b.customerNote && <><dt>{t.bk.note}</dt><dd className="adm-prewrap">{b.customerNote}</dd></>}
            <dt>{t.bk.privacyAccepted}</dt><dd>{dateTime(b.privacyAcceptedAt)}</dd>
          </dl>
        </div>
      </div>

      <div className="adm-card">
        <h2 className="adm-h2">{t.bk.nightly}</h2>
        <div className="adm-tablewrap">
          <table className="adm-table">
            <tbody>
              {b.item.nightly.map((n) => (
                <tr key={n.date}>
                  <td>{stayDate(n.date)}</td>
                  <td className="adm-num">{baht(n.priceSatang)} {b.item.pricingType === "PER_ADULT_NIGHT" ? t.bk.perAdultNight : t.bk.perNight}</td>
                </tr>
              ))}
              {b.tarp && (
                <tr>
                  <td>{format(t.bk.tarpNights, { n: b.tarp.nights })}</td>
                  <td className="adm-num">{baht(b.tarp.subtotalSatang)} ({baht(b.tarp.pricePerNightSatang)} {t.bk.perNight})</td>
                </tr>
              )}
              <tr className="adm-table__total"><th scope="row">{t.bk.accommodationSubtotal}</th><td className="adm-num">{baht(b.accommodationSubtotalSatang)}</td></tr>
            </tbody>
          </table>
        </div>

        {(b.includedMeals.length > 0 || b.food.length > 0) && <h2 className="adm-h2">{t.bk.food}</h2>}
        {b.includedMeals.map((m) => (
          <p key={m.categoryCode} className="adm-small">{t.bk.includedMeals}: {m.name} · {format(t.bk.persons, { n: m.personsPerNight })} × {format(t.bk.nights, { n: m.nights })}</p>
        ))}
        {b.food.length > 0 && (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr><th scope="col">{t.bk.serviceDate}</th><th scope="col">{t.bk.food}</th><th scope="col" className="adm-num">{t.bk.qty}</th><th scope="col" className="adm-num">{t.bk.total}</th></tr>
              </thead>
              <tbody>
                {[...includedFood, ...extraFood].map((f) => (
                  <tr key={`${f.optionId}|${f.serviceDate}|${f.includedQuantity}`}>
                    <td>{stayDate(f.serviceDate)}</td>
                    <td>{f.name} <span className="adm-muted adm-small">{f.categoryCode}</span></td>
                    <td className="adm-num">{f.quantity}{f.pricingType === "PER_PERSON" && <span className="adm-muted adm-small"> ({f.adults}+{f.children})</span>}</td>
                    <td className="adm-num">{f.includedQuantity > 0 ? t.bk.included : baht(f.subtotalSatang)}</td>
                  </tr>
                ))}
                <tr className="adm-table__total"><th scope="row" colSpan={3}>{t.bk.foodSubtotal}</th><td className="adm-num">{baht(b.foodSubtotalSatang)}</td></tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-total">{t.bk.total}: <strong>{baht(b.totalSatang)}</strong></p>
      </div>

      {can("payments.view") && <PaymentPanel key={`${b.status}-${b.paymentStatus}-${b.payments.length}`} booking={b} onChanged={() => setVersion((v) => v + 1)} />}

      {cancellable && (
        <div className="adm-card adm-card--danger">
          <h2 className="adm-h2">{t.bk.cancel}</h2>
          <div className="adm-field">
            <label htmlFor="cancel-reason">{t.bk.cancelReason}<span aria-hidden="true"> *</span></label>
            <textarea id="cancel-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Button variant="danger" disabled={reason.trim().length < 3} busy={busy} onClick={() => setConfirming(true)}>{t.bk.cancel}</Button>
          <ConfirmDialog open={confirming} danger message={t.bk.cancelConfirm} confirmLabel={t.bk.cancel}
            onConfirm={() => void cancel()} onCancel={() => setConfirming(false)} />
        </div>
      )}
    </section>
  );
}
