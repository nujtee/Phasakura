import { useEffect, useState, type FormEvent } from "react";
import { BOOKING_CODE_PATTERN, normalizeBookingCode, type BookingBriefDto, type BookingFindDto, type PublicBookingDto } from "../../shared/booking-types.ts";
import type { PaypalCaptureDto } from "../../shared/payment-types.ts";
import { pagePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { bookingErrorText, cancelPaypalOrder, capturePaypalOrder, findBookings, lookupBooking, recallAfterPaypal, requestBookingCode } from "../booking/api.ts";
import { StatusPill } from "../booking/Confirmation.tsx";
import { BalancePay } from "../booking/BalancePay.tsx";
import { PaymentInstructions } from "../booking/PaymentInstructions.tsx";
import { SlipStatus, SlipUpload } from "../booking/SlipUpload.tsx";
import { BookingSummary, useDateText, useDateTimeText } from "../booking/Summary.tsx";
import { GuestBillButton } from "../booking/Bill.tsx";
import { useBookingT } from "../booking/useBookingT.ts";
import { LineUpdates } from "../booking/LineUpdates.tsx";
import { paymentSubmittedEvent, useConfirmedBookingEvent } from "../analytics/booking-events.ts";

/**
 * Guest self-service. Either the Booking ID or the phone finds the booking (status and dates only); both
 * together open it — details, payment, slips — so one piece alone never acts on someone's booking.
 */
export function BookingLookupPage() {
  const { locale, t } = useI18n();
  const bt = useBookingT();
  const timeText = useDateTimeText();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<PublicBookingDto | null>(null);
  const [paypal, setPaypal] = useState<{ state: "checking" | "cancelled" } | { state: "done"; outcome: PaypalCaptureDto["outcome"]; orderId: string } | null>(null);
  useConfirmedBookingEvent(booking);
  const [forgot, setForgot] = useState<"form" | "sent" | null>(null);
  const [found, setFound] = useState<(BookingFindDto & { phone: string }) | null>(null);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestBookingCode(phone.trim());
      setForgot("sent");
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  async function open(bookingCode: string, guestPhone: string) {
    setBusy(true);
    setError(null);
    setBooking(null);
    try {
      setBooking(await lookupBooking(bookingCode, guestPhone));
      setFound(null);
      setCode(bookingCode);
      setPhone(guestPhone);
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  async function findOne(input: { bookingCode: string } | { phone: string }) {
    setBusy(true);
    setError(null);
    setBooking(null);
    setFound(null);
    try {
      const r = await findBookings(input);
      setFound({ ...r, phone: "phone" in input ? input.phone : "" });
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const c = code.trim();
    const p = phone.trim();
    if (c && p) void open(c, p);
    else if (c) void findOne({ bookingCode: c });
    else if (p) void findOne({ phone: p });
    else setError(bt.lookupNeedOne);
  }

  async function emailCodes(guestPhone: string) {
    setBusy(true);
    setError(null);
    try {
      await requestBookingCode(guestPhone);
      setForgot("sent");
      setFound(null);
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  async function finishPaypal(orderId: string, memory: { code: string; phone: string } | null) {
    setPaypal({ state: "checking" });
    try {
      const r = await capturePaypalOrder(orderId);
      setPaypal({ state: "done", outcome: r.outcome, orderId });
      setCode(r.bookingCode);
      if (memory && memory.code === r.bookingCode) await open(r.bookingCode, memory.phone);
    } catch (err) {
      setPaypal(null);
      setError(bookingErrorText(bt, err));
    }
  }

  // Back from PayPal (?paypal=return|cancel&token=<order>&code=<Booking ID>), or a link with ?code=.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const linked = p.get("code")?.toUpperCase() ?? null;
    if (linked && BOOKING_CODE_PATTERN.test(linked)) setCode(linked);
    const mode = p.get("paypal");
    const token = p.get("token");
    if (!mode || !token || !/^[A-Za-z0-9-]{8,64}$/.test(token)) return;
    // A reload must not repeat this (the server would answer the same, but quietly is better).
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${linked ? `?code=${encodeURIComponent(linked)}` : ""}`);
    const memory = recallAfterPaypal(linked);
    if (memory) setPhone(memory.phone);
    if (mode === "cancel") {
      setPaypal({ state: "cancelled" });
      void cancelPaypalOrder(token).catch(() => undefined);
      if (memory) void open(memory.code, memory.phone);
      return;
    }
    void finishPaypal(token, memory);
    // Runs once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paypalText = paypal?.state === "checking" ? bt.pay.paypalChecking
    : paypal?.state === "cancelled" ? bt.pay.paypalCancelled
    : paypal?.state === "done" ? {
      PAID: bt.pay.paypalPaid, PENDING_REVIEW: bt.pay.paypalPending, DECLINED: bt.pay.paypalDeclined,
      NOT_PAYABLE: bt.pay.paypalNotPayable, PROCESSING: bt.pay.paypalProcessing,
    }[paypal.outcome] : null;
  const paypalKind = paypal?.state === "done" ? (paypal.outcome === "PAID" ? "notice--ok" : paypal.outcome === "DECLINED" || paypal.outcome === "NOT_PAYABLE" ? "notice--error" : "") : "";

  return (
    <div className="page container lookup">
      <p className="detail__back"><Link to={pagePath(locale, "booking")}>← {t.accommodation.backToBooking}</Link></p>
      <h1 className="page__title">{bt.lookupTitle}</h1>
      <p className="page__lead">{forgot ? bt.forgotCodeIntro : bt.lookupIntro}</p>

      {forgot ? (
        <form className="flow-form lookup__form" onSubmit={(e) => void sendCode(e)}>
          {forgot === "sent" ? (
            <p className="notice notice--ok" role="status">{bt.forgotCodeSent}</p>
          ) : (
            <>
              <div className="form-field">
                <label htmlFor="fc-phone">{bt.phone}<span aria-hidden="true"> *</span></label>
                <input id="fc-phone" required type="tel" inputMode="tel" autoComplete="tel" maxLength={24} value={phone}
                  onChange={(e) => setPhone(e.target.value)} />
              </div>
              <button type="submit" className="button button--primary" disabled={busy} aria-busy={busy || undefined}>{bt.forgotCodeSend}</button>
            </>
          )}
          <p className="lookup__alt">
            <button type="button" className="link-button" onClick={() => { setForgot(null); setError(null); }}>← {bt.forgotCodeBack}</button>
          </p>
        </form>
      ) : (
      <form className="flow-form lookup__form" onSubmit={(e) => void submit(e)}>
        <div className="form-field">
          <label htmlFor="lk-code">{bt.bookingCode}</label>
          <input id="lk-code" maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false}
            placeholder={bt.bookingCodeHint} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            onBlur={(e) => setCode(normalizeBookingCode(e.target.value))} />
          <p className="field-hint">{bt.lookupCodeHelp}</p>
        </div>
        <p className="lookup__or" aria-hidden="true">{bt.lookupOr}</p>
        <div className="form-field">
          <label htmlFor="lk-phone">{bt.phone}</label>
          <input id="lk-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={24} value={phone}
            onChange={(e) => setPhone(e.target.value)} />
        </div>
        <button type="submit" className="button button--primary" disabled={busy} aria-busy={busy || undefined}>{bt.find}</button>
        <p className="lookup__alt">
          <button type="button" className="link-button" onClick={() => { setForgot("form"); setError(null); setBooking(null); }}>{bt.forgotCode}</button>
        </p>
      </form>
      )}

      {paypalText && (
        <div className={`notice ${paypalKind}`} role="status" aria-live="polite">
          <p>{paypalText}</p>
          {paypal?.state === "done" && paypal.outcome === "PROCESSING" && (
            <button type="button" className="button button--secondary" onClick={() => void finishPaypal(paypal.orderId, phone.trim() && code ? { code, phone: phone.trim() } : null)}>
              {bt.pay.checkAgain}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="notice notice--error">{error}</p>}

      {found && !booking && (
        <section className="lookup__found" aria-live="polite">
          {found.bookings.length === 0 ? (
            <p className="notice" role="status">{bt.lookupNoneByPhone}</p>
          ) : (
            <>
              <p className="lookup__found-lead">{found.by === "CODE" ? bt.lookupFoundAddPhone : bt.lookupFoundAddCode}</p>
              {found.bookings.map((b) => (
                <BriefCard key={b.bookingCodeMasked + b.checkIn} brief={b} by={found.by} busy={busy}
                  onOpen={(c, p) => void open(c, found.by === "PHONE" ? found.phone : p)} />
              ))}
              {found.by === "PHONE" && (
                <p className="lookup__alt">
                  <button type="button" className="link-button" disabled={busy} onClick={() => void emailCodes(found.phone)}>{bt.forgotCodeSend}</button>
                </p>
              )}
            </>
          )}
        </section>
      )}

      {booking && (
        <section className="lookup__result" aria-live="polite">
          <p className="confirmation__value" translate="no">{booking.bookingCode}</p>
          <p className="confirmation__status">{bt.status}: <StatusPill status={booking.status} paymentStatus={booking.paymentStatus} /></p>
          <p className="summary__meta">{booking.customerName} · {booking.customerPhoneMasked}</p>
          <SlipStatus booking={booking} />
          {booking.paymentInstructions ? (
            <PaymentInstructions payment={booking.paymentInstructions} expiresAt={booking.expiresAt} bookingCode={booking.bookingCode}
              laterSatang={booking.totalSatang - booking.paymentInstructions.amountDueSatang} phone={phone.trim()}
              slip={(channel) => (
                <SlipUpload bookingCode={booking.bookingCode} phone={phone.trim()} channel={channel}
                  onDone={(r) => { paymentSubmittedEvent(r.booking); setBooking(r.booking); }} />
              )} />
          ) : booking.expiresAt && <p className="notice" role="note">{fill(bt.holdUntil, { time: timeText(booking.expiresAt) })}</p>}
          <BalancePay booking={booking} phone={phone.trim()} onChange={setBooking} />
          <LineUpdates booking={booking} phone={phone.trim()} onChange={setBooking} />
          <BookingSummary quote={booking} />
          <GuestBillButton booking={booking} />
        </section>
      )}
    </div>
  );
}

/** A booking found with one piece: status and dates; the other piece opens it. */
function BriefCard({ brief, by, busy, onOpen }: { brief: BookingBriefDto; by: BookingFindDto["by"]; busy: boolean; onOpen: (code: string, phone: string) => void }) {
  const bt = useBookingT();
  const dateText = useDateText();
  const prefix = brief.bookingCodeMasked.replace(/••••$/, "");
  const [value, setValue] = useState("");
  const id = `brief-${brief.bookingCodeMasked}-${brief.checkIn}`;
  function go(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (by === "CODE") onOpen(brief.bookingCode!, v);
    else onOpen(normalizeBookingCode(v.length <= 4 ? prefix + v : v), "");
  }
  return (
    <article className="lookup__brief">
      <p className="lookup__brief-head">
        <span className="lookup__brief-code" translate="no">{brief.bookingCode ?? brief.bookingCodeMasked}</span>
        <StatusPill status={brief.status} paymentStatus={brief.paymentStatus} />
      </p>
      <p className="summary__meta">{dateText(brief.checkIn)} → {dateText(brief.checkOut)} · {brief.guestNameMasked}</p>
      <form className="lookup__brief-form" onSubmit={go}>
        <label htmlFor={id}>{by === "CODE" ? bt.lookupEnterPhone : bt.lookupEnterCodeEnd}</label>
        <div className="lookup__brief-row">
          {by === "PHONE" && <span className="lookup__brief-prefix" translate="no">{prefix}</span>}
          <input id={id} value={value} required autoComplete={by === "CODE" ? "tel" : "off"}
            type={by === "CODE" ? "tel" : "text"} inputMode={by === "CODE" ? "tel" : "text"}
            maxLength={by === "CODE" ? 24 : 4} spellCheck={false} autoCapitalize={by === "PHONE" ? "characters" : undefined}
            placeholder={by === "PHONE" ? "A7K2" : undefined}
            onChange={(e) => setValue(by === "PHONE" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : e.target.value)} />
          <button type="submit" className="button button--primary" disabled={busy}>{bt.lookupOpen}</button>
        </div>
      </form>
    </article>
  );
}
