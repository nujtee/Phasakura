import { useEffect, useId, useState } from "react";
import type { PublicBookingDto } from "../../shared/booking-types.ts";
import type { GuestLineDto, GuestLineLinkDto } from "../../shared/line-types.ts";
import { apiRequest } from "../api/client.ts";
import { bookingErrorText, lookupBooking } from "./api.ts";
import { useBookingT } from "./useBookingT.ts";

export function LineIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className="line-icon">
      <path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.5s5.9-3.5 8.1-6C21.4 14.3 22 12.7 22 11c0-4.4-4.5-8-10-8z" fill="currentColor" />
    </svg>
  );
}

/**
 * Guest opt-in for LINE updates (spec §47). Booking ID + phone prove the booking is theirs;
 * the link itself happens when the guest sends the one-time code to our Official Account.
 */
export function LineUpdates({ booking, phone, onChange }: { booking: PublicBookingDto; phone: string; onChange: (b: PublicBookingDto) => void }) {
  const bt = useBookingT();
  const id = useId();
  const [link, setLink] = useState<GuestLineLinkDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const state: GuestLineDto = booking.lineUpdates;

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await lookupBooking(booking.bookingCode, phone);
      onChange(fresh);
      setNote(fresh.lineUpdates.linked ? null : bt.line.pending);
      if (fresh.lineUpdates.linked) setLink(null);
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  // Coming back from the LINE app: check once.
  useEffect(() => {
    if (!link) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  if (!state.available && !state.linked) return null;

  async function connect() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setLink(await apiRequest<GuestLineLinkDto>("POST", "/api/public/bookings/line-link", { bookingCode: booking.bookingCode, phone }));
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<GuestLineDto>("POST", "/api/public/bookings/line-unlink", { bookingCode: booking.bookingCode, phone });
      onChange({ ...booking, lineUpdates: next });
      setNote(bt.line.stopped);
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="line-updates" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="line-updates__title"><LineIcon /> {bt.line.title}</h3>
      {state.linked ? (
        <>
          <p className="notice notice--ok" role="status">{bt.line.linked}</p>
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => void stop()}>{bt.line.stop}</button>
        </>
      ) : (
        <>
          <p className="line-updates__intro">{bt.line.intro}</p>
          {!link ? (
            <button type="button" className="button button--line" disabled={busy} aria-busy={busy || undefined} onClick={() => void connect()}>
              <LineIcon /> {bt.line.connect}
            </button>
          ) : (
            <div className="line-updates__step">
              <a className="button button--line" href={link.url} target="_blank" rel="noopener noreferrer"><LineIcon /> {bt.line.connect}</a>
              <p className="field-hint">{bt.line.openHint}</p>
              <p className="field-hint">{bt.line.manual}</p>
              <pre className="line-updates__message" translate="no">{link.message}</pre>
              <button type="button" className="button button--secondary" disabled={busy} aria-busy={busy || undefined} onClick={() => void refresh()}>{bt.line.check}</button>
            </div>
          )}
          <p className="field-hint">{bt.line.privacy}</p>
        </>
      )}
      {note && <p className="notice" role="status">{note}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
