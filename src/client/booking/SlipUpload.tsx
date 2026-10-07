import { useId, useState, type FormEvent } from "react";
import type { PublicBookingDto } from "../../shared/booking-types.ts";
import type { SlipUploadResultDto } from "../../shared/payment-types.ts";
import { apiUpload } from "../api/client.ts";
import { bookingErrorText } from "./api.ts";
import { useBookingT } from "./useBookingT.ts";

type Result = { booking: PublicBookingDto } & SlipUploadResultDto;

/** Guest slip upload. Booking ID + phone prove the booking is theirs; the image goes to private storage. */
export function SlipUpload({ bookingCode, phone, onDone }: { bookingCode: string; phone: string; onDone: (r: Result) => void }) {
  const bt = useBookingT();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("bookingCode", bookingCode);
      form.set("phone", phone);
      form.set("file", file);
      onDone(await apiUpload<Result>("/api/public/bookings/slip", form));
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="slip" onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="slip__title">{bt.slipTitle}</h3>
      <label className="slip__pick">
        <input type="file" accept="image/jpeg,image/png,image/webp" className="visually-hidden" id={`${id}-f`}
          aria-describedby={`${id}-hint`} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
        <span className="button button--secondary">{bt.chooseSlip}</span>
        <span className="slip__name">{file?.name ?? ""}</span>
      </label>
      <p id={`${id}-hint`} className="field-hint">{bt.slipHint}</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" className="button button--primary" disabled={!file || busy} aria-busy={busy || undefined}>
        {busy ? bt.sendingSlip : bt.sendSlip}
      </button>
    </form>
  );
}

/** Status line for the guest about their slip. */
export function SlipStatus({ booking }: { booking: PublicBookingDto }) {
  const bt = useBookingT();
  if (booking.paymentStatus === "PENDING_VERIFICATION") return <p className="notice" role="status">{bt.slipReceived}</p>;
  if (booking.paymentStatus === "VERIFIED" || booking.paymentStatus === "PAID") return <p className="notice notice--ok" role="status">{bt.slipVerified}</p>;
  if (booking.paymentStatus === "REJECTED" && booking.status === "PENDING") return <p className="notice notice--error" role="alert">{bt.slipRejected}</p>;
  return null;
}
