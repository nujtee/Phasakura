import { useEffect, useRef, useState } from "react";
import type { AdminBookingDto, BookingRoomChoicesDto } from "../../../shared/booking-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, errorMessage } from "../ui.tsx";

/**
 * Booking page → Stay → Change house: the booking keeps its dates and its price and moves to another house (or VIP
 * tent) of the same type. Every such accommodation is listed by name for each stay of the booking — the current
 * one, the free ones to choose, the ones taken on these nights (not selectable). The Worker checks again and
 * releases / takes the nights in one batch, so a house taken in the meantime is refused and the list reloads.
 */
export function ChangeRoom({ booking, onChanged }: { booking: AdminBookingDto; onChanged: (next: AdminBookingDto, message: string) => void }) {
  const { t, locale } = useAdmin();
  const code = booking.bookingCode;
  const stays = booking.items.filter((i) => i.status !== "CANCELLED" && i.unitId);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BookingRoomChoicesDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setData(null);
    setLoadError(null);
    apiGet<BookingRoomChoicesDto>(`/api/admin/bookings/${encodeURIComponent(code)}/rooms`, controller.signal)
      .then((res) => {
        setData(res);
        setChoice(Object.fromEntries(res.stays.map((st) => [st.itemId, st.unitId])));
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setLoadError(errorMessage(t, err)); });
    return () => controller.abort();
  }, [open, code, t, version]);

  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);

  if (!stays.length) return null;
  const label = stays.every((i) => i.type === "HOUSE") ? t.bk.changeHouse : stays.every((i) => i.type === "VIP_TENT") ? t.bk.changeTent : t.bk.changeRoom;

  if (!open) {
    return (
      <div className="adm-move__open">
        <Button variant="secondary" onClick={() => { setSaveError(null); setOpen(true); }}>{label}</Button>
      </div>
    );
  }

  const baht = (satang: number) => formatBaht(satang, locale.code);
  const changed = data ? data.stays.filter((st) => (choice[st.itemId] ?? st.unitId) !== st.unitId) : [];
  const chosen = data ? data.stays.map((st) => choice[st.itemId] ?? st.unitId) : [];
  const duplicate = new Set(chosen).size !== chosen.length;
  const nameOf = (st: BookingRoomChoicesDto["stays"][number], unitId: string) => st.options.find((o) => o.unitId === unitId)?.name ?? "";
  const changes = changed.map((st) => format(t.bk.moveRoomChange, { from: st.name, to: nameOf(st, choice[st.itemId]!) })).join(", ");
  const anywhere = !!data && data.stays.some((st) => st.options.some((o) => !o.own && o.free));

  async function save() {
    if (!data || !changed.length) return;
    setConfirming(false);
    setBusy(true);
    setSaveError(null);
    try {
      const next = await apiRequest<AdminBookingDto>("POST", `/api/admin/bookings/${encodeURIComponent(code)}/rooms`, {
        rooms: changed.map((st) => ({ itemId: st.itemId, unitId: choice[st.itemId]! })),
      });
      setOpen(false);
      onChanged(next, format(t.bk.changeRoomDone, { rooms: changes }));
    } catch (err) {
      // Most often the house was taken meanwhile: show the list as it is now.
      setSaveError(detailMessage(t, err));
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-move adm-room" role="group" aria-labelledby="room-h">
      <div className="adm-move__bar">
        <h3 className="adm-move__title" id="room-h" ref={heading} tabIndex={-1}>{label}</h3>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t.bk.changeRoomClose}</Button>
      </div>
      <p className="adm-field__hint">{t.bk.changeRoomHint}</p>
      {loadError && <Alert kind="error">{loadError}</Alert>}
      {!data && !loadError && <p role="status" className="adm-move__loading">{t.common.loading}</p>}
      {data && !anywhere && <Alert kind="info">{t.bk.changeRoomNone}</Alert>}
      {data && data.stays.map((st) => {
        const sel = choice[st.itemId] ?? st.unitId;
        const picked = st.options.find((o) => o.unitId === sel);
        return (
          <fieldset key={st.itemId} className="adm-room__stay" disabled={busy}>
            <legend>{format(t.bk.moveRoomFor, { name: st.name, guests: st.guests })}</legend>
            <ul className="adm-room__list">
              {st.options.map((o) => (
                <li key={o.unitId}>
                  <label className={`adm-room__option${o.free || o.own ? "" : " adm-room__option--busy"}`}>
                    <input type="radio" name={`room-${st.itemId}`} value={o.unitId} checked={sel === o.unitId} disabled={!o.free && !o.own}
                      onChange={() => { setSaveError(null); setChoice((cur) => ({ ...cur, [st.itemId]: o.unitId })); }} />
                    <span className="adm-room__name">{o.name}</span>
                    <span className="adm-room__state">{o.own ? t.bk.changeRoomCurrent : o.free ? t.bk.changeRoomFree : t.bk.moveRoomBusy}</span>
                  </label>
                </li>
              ))}
            </ul>
            {picked && !picked.own && <p className="adm-field__hint">{format(t.bk.moveRoomPrice, { price: baht(picked.priceSatang), booked: baht(st.bookedSatang) })}</p>}
          </fieldset>
        );
      })}
      {duplicate && <p className="adm-field__error" role="alert">{t.bk.moveDuplicate}</p>}
      {saveError && <p className="adm-field__error" role="alert">{saveError}</p>}
      <Button disabled={!changed.length || duplicate} busy={busy} onClick={() => setConfirming(true)}>{t.bk.changeRoomSave}</Button>
      <ConfirmDialog open={confirming} confirmLabel={t.bk.changeRoomSave}
        message={format(t.bk.changeRoomConfirm, { code, rooms: changes })}
        onConfirm={() => void save()} onCancel={() => setConfirming(false)} />
    </div>
  );
}
