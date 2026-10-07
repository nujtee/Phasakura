import { useState, type FormEvent } from "react";
import type { PublicBookingDto } from "../../shared/booking-types.ts";
import { pagePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { bookingErrorText, lookupBooking } from "../booking/api.ts";
import { StatusPill } from "../booking/Confirmation.tsx";
import { PaymentInstructions } from "../booking/PaymentInstructions.tsx";
import { SlipStatus, SlipUpload } from "../booking/SlipUpload.tsx";
import { BookingSummary, useDateTimeText } from "../booking/Summary.tsx";
import { useBookingT } from "../booking/useBookingT.ts";

/** Guest self-service: Booking ID + phone (both required — no enumeration). */
export function BookingLookupPage() {
  const { locale, t } = useI18n();
  const bt = useBookingT();
  const timeText = useDateTimeText();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<PublicBookingDto | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setBooking(null);
    try {
      setBooking(await lookupBooking(code.trim(), phone.trim()));
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page container lookup">
      <p className="detail__back"><Link to={pagePath(locale, "booking")}>← {t.accommodation.backToBooking}</Link></p>
      <h1 className="page__title">{bt.lookupTitle}</h1>
      <p className="page__lead">{bt.lookupIntro}</p>

      <form className="flow-form lookup__form" onSubmit={(e) => void submit(e)}>
        <div className="form-field">
          <label htmlFor="lk-code">{bt.bookingCode}<span aria-hidden="true"> *</span></label>
          <input id="lk-code" required maxLength={20} autoComplete="off" autoCapitalize="characters" spellCheck={false}
            placeholder={bt.bookingCodeHint} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </div>
        <div className="form-field">
          <label htmlFor="lk-phone">{bt.phone}<span aria-hidden="true"> *</span></label>
          <input id="lk-phone" required type="tel" inputMode="tel" autoComplete="tel" maxLength={24} value={phone}
            onChange={(e) => setPhone(e.target.value)} />
        </div>
        <button type="submit" className="button button--primary" disabled={busy} aria-busy={busy || undefined}>{bt.find}</button>
      </form>

      {error && <p role="alert" className="notice notice--error">{error}</p>}

      {booking && (
        <section className="lookup__result" aria-live="polite">
          <p className="confirmation__value" translate="no">{booking.bookingCode}</p>
          <p className="confirmation__status">{bt.status}: <StatusPill status={booking.status} /></p>
          <p className="summary__meta">{booking.customerName} · {booking.customerPhoneMasked}</p>
          <SlipStatus booking={booking} />
          {booking.paymentInstructions ? (
            <PaymentInstructions payment={booking.paymentInstructions} expiresAt={booking.expiresAt}>
              <SlipUpload bookingCode={booking.bookingCode} phone={phone.trim()} onDone={(r) => setBooking(r.booking)} />
            </PaymentInstructions>
          ) : booking.expiresAt && <p className="notice" role="note">{fill(bt.holdUntil, { time: timeText(booking.expiresAt) })}</p>}
          <BookingSummary quote={booking} />
        </section>
      )}
    </div>
  );
}
