import { useState, type FormEvent } from "react";
import type { AdminBookingDto } from "../../../shared/booking-types.ts";
import { apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, Field, detailMessage } from "../ui.tsx";

/** Booking → guest details → "แก้ไข": name, phone, e-mail, LINE ID (bookings.edit; audited). */
export function EditCustomer({ booking, onSaved, onClose }: { booking: AdminBookingDto; onSaved: (next: AdminBookingDto) => void; onClose: () => void }) {
  const { t } = useAdmin();
  const [form, setForm] = useState({
    name: booking.customerName, phone: booking.customerPhone, email: booking.customerEmail ?? "", lineId: booking.customerLineId ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<AdminBookingDto>("PUT", `/api/admin/bookings/${encodeURIComponent(booking.bookingCode)}/customer`, {
        name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim() || null, lineId: form.lineId.trim() || null,
      });
      onSaved(next);
    } catch (err) {
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="adm-form-narrow" onSubmit={(e) => void save(e)} aria-label={t.bk.editCustomer}>
      {error && <Alert kind="error">{error}</Alert>}
      <Field label={t.users.name} value={form.name} onChange={set("name")} required maxLength={100} autoComplete="off" />
      <Field label={t.bk.phone} value={form.phone} onChange={set("phone")} required maxLength={24} inputMode="tel" autoComplete="off" />
      <Field label={t.bk.email} type="email" value={form.email} onChange={set("email")} maxLength={254} autoComplete="off" />
      <Field label={t.bk.lineId} value={form.lineId} onChange={set("lineId")} maxLength={50} autoComplete="off" />
      <p className="adm-small adm-muted">{t.bk.editCustomerHint}</p>
      <div className="adm-row">
        <Button type="submit" busy={busy}>{t.common.save}</Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
      </div>
    </form>
  );
}
