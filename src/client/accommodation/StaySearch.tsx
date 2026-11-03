import { useId, useState, type FormEvent } from "react";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useBookingT } from "../booking/useBookingT.ts";
import { fill } from "./UnitCard.tsx";
import { nightsBetween, stayLimits, type StayQuery } from "./data.ts";
import { Stepper } from "../booking/FoodStep.tsx";

/** Date + guests search form. Native date inputs: accessible and mobile-friendly. */
export function StaySearch({
  initial,
  busy,
  error,
  showTents = true,
  showGuests = true,
  childAge,
  maxGuests,
  maxAdults,
  onSearch,
}: {
  /** "Children (under N)" — N comes from the camping settings in D1. */
  childAge?: number;
  initial: StayQuery;
  busy: boolean;
  error: string | null;
  showTents?: boolean;
  /** A house page: no more guests than the unit takes (adults within its adult limit). */
  maxGuests?: number;
  maxAdults?: number | null;
  /** Booking page: dates only — guests are set per house / VIP tent once chosen (and in the camping form). */
  showGuests?: boolean;
  onSearch: (q: StayQuery) => void;
}) {
  const { t } = useI18n();
  const bt = useBookingT();
  const id = useId();
  const cap = maxGuests ?? 50;
  const adultCap = Math.min(maxAdults ?? cap, cap);
  // Never more than the unit takes, even from a link or a typed number.
  const fit = (x: StayQuery): StayQuery => {
    const adults = Math.max(1, Math.min(adultCap, x.adults));
    return { ...x, adults, children: Math.max(0, Math.min(cap - adults, x.children)) };
  };
  const [q, setQ] = useState(() => fit(initial));
  const limits = stayLimits();
  const nights = nightsBetween(q);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(q);
  };

  return (
    <form className={`stay-search${showTents ? "" : " stay-search--no-tents"}${showGuests ? "" : " stay-search--dates"}`} onSubmit={submit} aria-describedby={error ? `${id}-err` : undefined}>
      <div className="stay-search__field">
        <label htmlFor={`${id}-in`}>{t.accommodation.checkIn}</label>
        <input id={`${id}-in`} type="date" required min={limits.min} max={limits.max} value={q.checkIn}
          onChange={(e) => setQ({ ...q, checkIn: e.target.value })} />
      </div>
      <div className="stay-search__field">
        <label htmlFor={`${id}-out`}>{t.accommodation.checkOut}</label>
        <input id={`${id}-out`} type="date" required min={q.checkIn || limits.min} max={limits.max} value={q.checkOut}
          onChange={(e) => setQ({ ...q, checkOut: e.target.value })} />
      </div>
      {/* Guests and tents: − / + only (no typing on phones; never above what the unit takes). */}
      {showGuests && <>
      <div className="stay-search__field stay-search__field--small">
        <span className="stay-search__label">{bt.adults}</span>
        <Stepper label={bt.adults} value={q.adults} min={1} max={Math.max(1, Math.min(adultCap, cap - q.children))}
          onChange={(n) => setQ(fit({ ...q, adults: n }))} />
      </div>
      <div className="stay-search__field stay-search__field--small">
        <span className="stay-search__label">{childAge ? fill(bt.children, { age: childAge }) : bt.childrenShort}</span>
        <Stepper label={childAge ? fill(bt.children, { age: childAge }) : bt.childrenShort} value={q.children} min={0}
          max={Math.max(0, cap - q.adults)} onChange={(n) => setQ(fit({ ...q, children: n }))} />
      </div>
      {maxGuests !== undefined && <p className="stay-search__limit">{fill(bt.searchMaxGuests, { n: maxGuests })}</p>}
      </>}
      {showTents && (
        <div className="stay-search__field stay-search__field--small">
          <span className="stay-search__label">{t.accommodation.tents}</span>
          <Stepper label={t.accommodation.tents} value={q.tents} min={1} max={50} onChange={(n) => setQ({ ...q, tents: n })} />
        </div>
      )}
      <div className="stay-search__submit">
        <button type="submit" className="button button--primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? t.accommodation.searching : t.accommodation.search}
        </button>
        {nights > 0 && <span className="stay-search__nights">{fill(t.accommodation.nights, { n: nights })}</span>}
      </div>
      {error && <p id={`${id}-err`} className="stay-search__error" role="alert">{error}</p>}
    </form>
  );
}
