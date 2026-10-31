import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  BookingMoveOptionsDto, BookingMoveRoomsDto, GuestMoveRequestDto, GuestMoveStartDto, MoveDayState,
} from "../../shared/booking-types.ts";
import { normalizeBookingCode } from "../../shared/booking-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { addDays } from "../../shared/dates.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { apiRequest } from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { bookingErrorText } from "./api.ts";
import { PaymentInstructions } from "./PaymentInstructions.tsx";
import { SlipUpload } from "./SlipUpload.tsx";
import { useDateText } from "./Summary.tsx";
import { useBookingT } from "./useBookingT.ts";

type Who = { bookingCode: string; phone: string };
const post = <T,>(path: string, who: Who, extra: Record<string, unknown> = {}) =>
  apiRequest<T>("POST", `/api/public/bookings/move${path}`, { ...who, ...extra });

/**
 * Booking page → "เลื่อนวันเข้าพัก": Booking ID + phone, then the guest picks new dates (another free house / VIP tent
 * when theirs is taken), transfers the date change fee (+ any higher price) and sends the slip. The booking moves once
 * the slip is verified (migration 0045).
 */
export function MoveStayLauncher() {
  const bt = useBookingT();
  const m = bt.move;
  const id = useId();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<{ who: Who; start: GuestMoveStartDto } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  async function open(e: FormEvent) {
    e.preventDefault();
    const who = { bookingCode: normalizeBookingCode(code), phone: phone.trim() };
    if (!who.bookingCode || !who.phone) return;
    setBusy(true);
    setError(null);
    try {
      setState({ who, start: await post<GuestMoveStartDto>("/start", who) });
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (state) panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [state]);

  return (
    <>
      <form className="move-launch" onSubmit={(e) => void open(e)} aria-labelledby={`${id}-h`}>
        <h2 id={`${id}-h`} className="move-launch__title">{m.open}</h2>
        <div className="move-launch__fields">
          <label className="move-launch__field">
            <span>{m.code}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" placeholder="BK-…" maxLength={40} required />
          </label>
          <label className="move-launch__field">
            <span>{m.phone}</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" autoComplete="tel" inputMode="tel" maxLength={24} required />
          </label>
          <button type="submit" className="button button--secondary move-launch__go" disabled={busy} aria-busy={busy || undefined}>
            {busy ? m.checking : m.go}
          </button>
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
      {state && (
        <div ref={panel} className="move-panel-wrap">
          <MoveStayPanel who={state.who} start={state.start} onChange={(start) => setState({ who: state.who, start })} onClose={() => setState(null)} />
        </div>
      )}
    </>
  );
}

function MoveStayPanel({ who, start, onChange, onClose }: { who: Who; start: GuestMoveStartDto; onChange: (s: GuestMoveStartDto) => void; onClose: () => void }) {
  const { locale } = useI18n();
  const bt = useBookingT();
  const m = bt.move;
  const dateText = useDateText();
  const baht = (s: number) => formatBaht(s, locale.code);
  const r = start.request;
  const [choosing, setChoosing] = useState(false);
  const open = r && (r.status === "AWAITING_PAYMENT" || r.status === "REVIEWING");
  const reload = async () => onChange(await post<GuestMoveStartDto>("/start", who));

  const ended = r && !open ? endedText(r, m, dateText) : null;
  const canChoose = !open && !start.blocked;

  return (
    <section className="move-panel" aria-labelledby="move-panel-h">
      <div className="move-panel__head">
        <h2 id="move-panel-h">{m.title}</h2>
        <button type="button" className="button button--ghost" onClick={onClose}>{m.close}</button>
      </div>
      <p className="move-panel__current">
        <strong>{m.current}: {start.bookingCode}</strong> · {start.customerName}
        <br />
        {fill(m.stayLine, { checkIn: dateText(start.checkIn), checkOut: dateText(start.checkOut), n: start.nights })}
        {start.stays.length > 0 && <> · {start.stays.map((s) => s.name).join(", ")}</>}
      </p>
      {!start.blocked && (
        <p className="move-panel__terms">
          {fill(start.feeSatang > 0 ? m.feeNote : m.feeFree, { fee: baht(start.feeSatang), days: start.minDaysBefore, left: start.movesLeft })}
        </p>
      )}
      {start.blocked && !open && <p className="notice notice--error" role="alert">{m.blocked[start.blocked] ?? bt.errors.UNKNOWN}</p>}
      {ended && <p className={`notice${r!.status === "APPROVED" ? " notice--ok" : " notice--error"}`} role="status">{ended}</p>}

      {r?.status === "AWAITING_PAYMENT" && <MovePay who={who} request={r} onDone={reload} />}
      {r?.status === "REVIEWING" && <p className="notice" role="status">{m.reviewing}</p>}

      {canChoose && (choosing || !r ? (
        <MoveChoose who={who} start={start} onRequested={(req) => { setChoosing(false); onChange({ ...start, request: req, blocked: null }); }} />
      ) : (
        <button type="button" className="button button--secondary" onClick={() => setChoosing(true)}>{m.again}</button>
      ))}
    </section>
  );
}

function endedText(r: GuestMoveRequestDto, m: ReturnType<typeof useBookingT>["move"], dateText: (d: string) => string): string {
  switch (r.status) {
    case "APPROVED": return fill(m.approved, { checkIn: dateText(r.toCheckIn), checkOut: dateText(r.toCheckOut) });
    case "REJECTED": return fill(m.rejected, { reason: r.reason ? ` — ${r.reason}` : "" });
    case "EXPIRED": return m.expired;
    case "CANCELLED": return m.cancelled;
    default: return m.failed;
  }
}

/** The transfer for a held change: QR / account, then the slip. */
function MovePay({ who, request, onDone }: { who: Who; request: GuestMoveRequestDto; onDone: () => Promise<void> }) {
  const bt = useBookingT();
  const m = bt.move;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!request.paymentInstructions) return <p className="notice">{m.reviewing}</p>;
  async function giveUp() {
    setBusy(true);
    setError(null);
    try {
      await post("/cancel", who);
      await onDone();
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="move-pay">
      <PaymentInstructions payment={request.paymentInstructions} expiresAt={request.expiresAt} bookingCode={who.bookingCode} phone={who.phone}
        labels={{ title: m.payTitle, amount: m.amount, intro: m.payIntro, afterTransfer: m.payAfter }}
        slip={(channel) => (
          <SlipUpload<{ outcome: string; move: GuestMoveStartDto }> bookingCode={who.bookingCode} phone={who.phone} channel={channel}
            path="/api/public/bookings/move/slip" onDone={() => void onDone()} />
        )} />
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="button" className="button button--ghost move-pay__giveup" disabled={busy} onClick={() => void giveUp()}>{m.giveUp}</button>
    </div>
  );
}

const PICKABLE: MoveDayState[] = ["OK", "OTHER_UNITS"];
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const nextMonth = (d: string) => {
  const [y, mo] = d.split("-").map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
};
const prevMonth = (d: string) => {
  const [y, mo] = d.split("-").map(Number) as [number, number];
  return mo === 1 ? `${y - 1}-12-01` : `${y}-${String(mo - 1).padStart(2, "0")}-01`;
};
const daysIn = (first: string) => {
  const [y, mo] = first.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
};

/** Calendar → rooms on the picked day → summary → ask. */
function MoveChoose({ who, start, onRequested }: { who: Who; start: GuestMoveStartDto; onRequested: (r: GuestMoveRequestDto) => void }) {
  const { locale } = useI18n();
  const bt = useBookingT();
  const m = bt.move;
  const dateText = useDateText();
  const baht = (s: number) => formatBaht(s, locale.code);
  const [month, setMonth] = useState(() => monthStart(start.earliest));
  const [days, setDays] = useState<BookingMoveOptionsDto | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [rooms, setRooms] = useState<BookingMoveRoomsDto | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDays(null);
    post<BookingMoveOptionsDto>("/calendar", who, { from: month, days: daysIn(month) })
      .then((d) => live && setDays(d))
      .catch((err: unknown) => live && setError(bookingErrorText(bt, err)));
    return () => { live = false; };
  }, [month, who, bt]);

  async function pick(d: string) {
    setDay(d);
    setRooms(null);
    setError(null);
    try {
      const r = await post<BookingMoveRoomsDto>("/rooms", who, { checkIn: d });
      setRooms(r);
      setChosen(Object.fromEntries(r.stays.map((s) => [s.itemId, s.suggested ?? ""])));
    } catch (err) {
      setError(bookingErrorText(bt, err));
    }
  }

  const fits = rooms && PICKABLE.includes(rooms.state);
  const diff = useMemo(() => {
    if (!rooms) return 0;
    const total = rooms.stays.reduce((acc, s) => acc + (s.options.find((o) => o.unitId === chosen[s.itemId])?.priceSatang ?? s.bookedSatang) - s.bookedSatang, 0);
    return Math.max(0, total);
  }, [rooms, chosen]);
  const ready = fits && rooms!.stays.every((s) => chosen[s.itemId]);

  async function confirm() {
    if (!rooms || !day) return;
    setBusy(true);
    setError(null);
    try {
      const req = await post<GuestMoveRequestDto>("", who, {
        checkIn: day, rooms: rooms.stays.map((s) => ({ itemId: s.itemId, unitId: chosen[s.itemId]! })),
      });
      onRequested(req);
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  const first = month;
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
  const monthName = new Intl.DateTimeFormat(locale.code, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${first}T00:00:00Z`));
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale.code, { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + i))));
  const stateOf = (d: string) => days?.days.find((x) => x.date === d)?.state ?? null;

  return (
    <div className="move-choose">
      <h3>{m.pickDay}</h3>
      <div className="move-cal" role="group" aria-label={m.pickDay}>
        <div className="move-cal__nav">
          <button type="button" className="button button--ghost" onClick={() => setMonth(prevMonth(month))}
            disabled={month <= monthStart(start.earliest)} aria-label={m.prev}>‹</button>
          <strong aria-live="polite">{monthName}</strong>
          <button type="button" className="button button--ghost" onClick={() => setMonth(nextMonth(month))} aria-label={m.next}>›</button>
        </div>
        <div className="move-cal__grid">
          {weekdays.map((w, i) => <span key={`w${i}`} className="move-cal__wd" aria-hidden="true">{w}</span>)}
          {Array.from({ length: lead }, (_, i) => <span key={`e${i}`} />)}
          {Array.from({ length: daysIn(first) }, (_, i) => {
            const d = addDays(first, i);
            const st = stateOf(d);
            const ok = st !== null && PICKABLE.includes(st);
            return (
              <button key={d} type="button" className={`move-day move-day--${(st ?? "LOADING").toLowerCase()}${day === d ? " is-selected" : ""}`}
                disabled={!ok} aria-pressed={day === d} onClick={() => void pick(d)}
                aria-label={`${dateText(d)} · ${st === "OK" ? m.legendOk : st === "OTHER_UNITS" ? m.legendOther : st === "CURRENT" ? m.current : m.legendTaken}`}>
                {i + 1}
              </button>
            );
          })}
        </div>
        {!days && <p className="move-cal__loading" role="status">{m.loading}</p>}
        <p className="move-cal__legend">
          <span className="move-key move-key--ok" /> {m.legendOk} <span className="move-key move-key--other_units" /> {m.legendOther}{" "}
          <span className="move-key move-key--taken" /> {m.legendTaken}
        </p>
      </div>

      {rooms && day && (
        <div className="move-rooms">
          <h3>{m.newStay}: {fill(m.stayLine, { checkIn: dateText(rooms.checkIn), checkOut: dateText(rooms.checkOut), n: start.nights })}</h3>
          {!fits && (rooms.nearest.length ? (
            <div className="move-nearest">
              <p>{m.nearest}</p>
              <div className="move-nearest__list">
                {rooms.nearest.map((n) => (
                  <button key={n.checkIn} type="button" className="button button--secondary"
                    onClick={() => { setMonth(monthStart(n.checkIn)); void pick(n.checkIn); }}>
                    {dateText(n.checkIn)}
                  </button>
                ))}
              </div>
            </div>
          ) : <p className="notice">{m.noneNear}</p>)}
          {fits && rooms.stays.map((s) => {
            const ownFree = s.options.some((o) => o.own && o.free);
            const free = s.options.filter((o) => o.free);
            return (
              <fieldset key={s.itemId} className="move-stay-rooms">
                <legend>{ownFree ? fill(m.ownFree, { name: s.name }) : fill(m.ownTaken, { name: s.name })}</legend>
                {free.map((o) => (
                  <label key={o.unitId} className={`move-room${chosen[s.itemId] === o.unitId ? " is-selected" : ""}`}>
                    <input type="radio" name={`room-${s.itemId}`} value={o.unitId} checked={chosen[s.itemId] === o.unitId}
                      onChange={() => setChosen({ ...chosen, [s.itemId]: o.unitId })} />
                    <span>
                      <strong>{o.name}</strong>
                      <small>{fill(m.price, { price: baht(o.priceSatang), n: start.nights })}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            );
          })}
          {fits && (
            <div className="move-summary" aria-live="polite">
              <h3>{m.summary}</h3>
              <dl>
                <div><dt>{m.from}</dt><dd>{fill(m.stayLine, { checkIn: dateText(start.checkIn), checkOut: dateText(start.checkOut), n: start.nights })}</dd></div>
                <div><dt>{m.to}</dt><dd>{fill(m.stayLine, { checkIn: dateText(rooms.checkIn), checkOut: dateText(rooms.checkOut), n: start.nights })}</dd></div>
                {rooms.stays.filter((s) => chosen[s.itemId] && chosen[s.itemId] !== s.unitId).map((s) => (
                  <div key={s.itemId}><dt>{m.room}</dt><dd>{s.name} → {s.options.find((o) => o.unitId === chosen[s.itemId])?.name}</dd></div>
                ))}
                <div><dt>{m.fee}</dt><dd>{baht(start.feeSatang)}</dd></div>
                {diff > 0 && <div><dt>{m.diff}</dt><dd>{baht(diff)}</dd></div>}
                <div className="move-summary__total"><dt>{m.amount}</dt><dd>{baht(start.feeSatang + diff)}</dd></div>
              </dl>
              <p className="field-hint">{m.diffNote}</p>
              <button type="button" className="button button--primary" disabled={!ready || busy} aria-busy={busy || undefined} onClick={() => void confirm()}>
                {busy ? m.confirming : m.confirm}
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
