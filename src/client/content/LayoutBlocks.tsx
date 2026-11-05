import { useId, useState, type FormEvent } from "react";
import { addDays, todayIn } from "../../shared/dates.ts";
import { pagePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useRouter } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { useContentT } from "./useContentT.ts";

/**
 * Blocks the theme layouts (Settings → Theme, migration 0061) add to the home page: a quick availability bar under
 * the hero and a "book with confidence" strip. CLASSIC shows neither. Facts only — no ratings or numbers the
 * site does not have.
 */

/** Check-in / check-out → the booking page with those dates (it reads ?checkIn=&checkOut=). */
export function BookBar() {
  const { locale } = useI18n();
  const { navigate } = useRouter();
  const lt = useContentT().layout;
  const id = useId();
  const today = todayIn("Asia/Bangkok");
  const [checkIn, setCheckIn] = useState(addDays(today, 1));
  const [checkOut, setCheckOut] = useState(addDays(today, 2));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const out = checkOut > checkIn ? checkOut : addDays(checkIn, 1);
    navigate(`${pagePath(locale, "booking")}?checkIn=${checkIn}&checkOut=${out}`);
  };
  return (
    <div className="container layout-bookbar-wrap">
      <form className="layout-bookbar" onSubmit={submit} aria-label={lt.bookBar}>
        <label className="layout-bookbar__field" htmlFor={`${id}-in`}>
          <span>{lt.checkIn}</span>
          <input id={`${id}-in`} type="date" required min={today} value={checkIn}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setCheckIn(v);
              if (v && checkOut <= v) setCheckOut(addDays(v, 1));
            }} />
        </label>
        <label className="layout-bookbar__field" htmlFor={`${id}-out`}>
          <span>{lt.checkOut}</span>
          <input id={`${id}-out`} type="date" required min={addDays(checkIn || today, 1)} value={checkOut}
            onChange={(e) => setCheckOut(e.currentTarget.value)} />
        </label>
        <button type="submit" className="layout-bookbar__submit">{lt.search}</button>
      </form>
    </div>
  );
}

function Icon({ name }: { name: "shield" | "card" | "search" | "chat" }) {
  const paths: Record<typeof name, string[]> = {
    shield: ["M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z", "M9 12l2 2 4-4"],
    card: ["M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M3 10h18"],
    search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
    chat: ["M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"],
  };
  return (
    <svg className="layout-trust__icon" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** What booking here is like — true for every site on the platform (Booking ID, slip check, look-up, LINE when set). */
export function TrustStrip() {
  const lt = useContentT().layout;
  const { site } = useSite();
  const items = [
    { icon: "shield" as const, title: lt.trustDirect, text: lt.trustDirectText },
    { icon: "card" as const, title: lt.trustSlip, text: lt.trustSlipText },
    { icon: "search" as const, title: lt.trustCheck, text: lt.trustCheckText },
    ...(site?.contact.lineOaUrl || site?.lineButton ? [{ icon: "chat" as const, title: lt.trustLine, text: lt.trustLineText }] : []),
  ];
  return (
    <section className="container layout-trust" aria-label={lt.trust}>
      <ul>
        {items.map((x) => (
          <li key={x.icon}>
            <Icon name={x.icon} />
            <span><strong>{x.title}</strong><span>{x.text}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}
