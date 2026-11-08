import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { AvailabilityDto, PublicUnitDto, PromotionBriefDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { addDays } from "../../shared/dates.ts";
import { accommodationPath, pagePath } from "../../shared/routes.ts";
import { defaultStay, fetchAvailability, nightsBetween, rememberStay, stayLimits, useAccommodations, type StayQuery } from "../accommodation/data.ts";
import { promoPerks, usePromo } from "../booking/Promotions.tsx";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { ResponsiveImage } from "./ResponsiveImage.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { useContentT } from "./useContentT.ts";

/**
 * Theme layout D · Stay List (migration 0062): the home page as a hotel-search page — a search box for the dates and
 * guests, type filters, sorting, and one row per house / VIP tent / the camping ground with what is free and the
 * price for those dates (the live availability every booking uses). "Choose" opens the booking page with the stay.
 */

type Kind = "HOUSE" | "TENT" | "CAMPING";
interface Row {
  key: string;
  kind: Kind;
  name: string;
  text: string | null;
  cover: PublicUnitDto["cover"];
  capacity: { n: number; max: number } | null;
  free: boolean;
  /** Why not (when not free). */
  why: string | null;
  scarcity: string | null;
  total: number;
  list: number | null;
  promotions: PromotionBriefDto[];
  href: string;
  details: string | null;
  order: number;
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const sum = (xs: number[] | undefined) => (xs ?? []).reduce((a, b) => a + b, 0);

export function StayList() {
  const { locale, t } = useI18n();
  const ct = useContentT();
  const lt = ct.layout.list;
  const m = usePromo();
  const id = useId();
  const { data } = useAccommodations(locale.path);
  const limits = stayLimits();
  const [draft, setDraft] = useState<StayQuery>(defaultStay);
  const [query, setQuery] = useState<StayQuery>(defaultStay);
  const [avail, setAvail] = useState<AvailabilityDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind | "ALL">("ALL");
  const [sort, setSort] = useState<"RECOMMENDED" | "PRICE">("RECOMMENDED");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async (q: StayQuery) => {
    setLoading(true);
    setError(null);
    const res = await fetchAvailability(q, t);
    setLoading(false);
    if (res.data) setAvail(res.data);
    else setError(res.error ?? lt.loadError);
  }, [t, lt.loadError]);
  useEffect(() => { void load(query); }, [load, query]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const out = draft.checkOut > draft.checkIn ? draft.checkOut : addDays(draft.checkIn, 1);
    setQuery({ ...draft, checkOut: out });
    rememberStay({ ...draft, checkOut: out });
    setDraft((d) => ({ ...d, checkOut: out }));
    setEditing(false);
  };

  const nights = nightsBetween(query);
  const baht = (n: number) => formatBaht(n, locale.code);
  const day = useMemo(() => new Intl.DateTimeFormat(locale.code, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), [locale.code]);
  const d = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));
  const params = (extra: Record<string, string> = {}) => new URLSearchParams({
    checkIn: query.checkIn, checkOut: query.checkOut, adults: String(query.adults), children: String(query.children), ...extra,
  }).toString();

  const rows = useMemo<Row[]>(() => {
    if (!data || !avail) return [];
    const out: Row[] = [];
    const units: [PublicUnitDto, Kind][] = [...data.houses.map((u) => [u, "HOUSE"] as [PublicUnitDto, Kind]), ...data.vipTents.map((u) => [u, "TENT"] as [PublicUnitDto, Kind])];
    units.forEach(([u, k], i) => {
      const a = avail.units.find((x) => x.unitId === u.id);
      if (!a) return;
      const free = a.available && a.fitsGuests;
      const total = sum(a.nightlyPricesSatang);
      const list = a.listPricesSatang ? sum(a.listPricesSatang) : null;
      out.push({
        key: u.id, kind: k, name: u.name, text: u.shortDescription, cover: u.cover,
        capacity: { n: u.standardGuests, max: u.maxGuests }, free,
        why: !a.available ? lt.full : !a.fitsGuests ? fill(lt.tooMany, { n: u.maxGuests }) : null,
        scarcity: free ? (k === "HOUSE" ? lt.leftHouse : lt.leftTent) : null,
        total, list: list !== null && list > total ? list : null, promotions: a.promotions ?? [],
        href: `${pagePath(locale, "booking")}?${params({ unit: u.slug })}`, details: accommodationPath(locale, u.slug), order: i,
      });
    });
    const c = data.camping;
    if (c.enabled && avail.camping.enabled) {
      const total = sum(avail.camping.nightlyPricePerAdultSatang) * query.adults;
      const list = avail.camping.listPricePerAdultSatang ? sum(avail.camping.listPricePerAdultSatang) * query.adults : null;
      const free = avail.camping.remaining > 0;
      out.push({
        key: "camping", kind: "CAMPING", name: c.name ?? lt.camping, text: c.description, cover: c.cover, capacity: null, free,
        why: free ? null : lt.full, scarcity: free ? fill(lt.leftCamping, { n: avail.camping.remaining }) : null,
        total, list: list !== null && list > total ? list : null, promotions: avail.camping.promotions ?? [],
        href: `${pagePath(locale, "booking")}?${params({ tents: "1" })}#sec-camping`, details: null, order: units.length,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params() reads query, listed
  }, [data, avail, query, locale, lt]);

  const counts = { HOUSE: rows.filter((r) => r.kind === "HOUSE").length, TENT: rows.filter((r) => r.kind === "TENT").length, CAMPING: rows.filter((r) => r.kind === "CAMPING").length };
  const shown = rows
    .filter((r) => kind === "ALL" || r.kind === kind)
    .sort((a, b) => Number(b.free) - Number(a.free) || (sort === "PRICE" ? a.total - b.total : a.order - b.order));
  const freeCount = shown.filter((r) => r.free).length;
  const chips: [Kind | "ALL", string, number][] = [
    ["ALL", lt.all, rows.length],
    ...([["HOUSE", lt.house, counts.HOUSE], ["TENT", lt.tent, counts.TENT], ["CAMPING", lt.camping, counts.CAMPING]] as [Kind, string, number][]).filter((c) => c[2] > 0),
  ];

  return (
    <section className="stay-list" aria-labelledby={`${id}-found`}>
      <div className="stay-list__band">
        <div className="container">
          <form className={`stay-list__search${editing ? " is-editing" : ""}`} onSubmit={submit} aria-label={ct.layout.bookBar}>
            <button type="button" className="stay-list__summary" aria-expanded={editing} aria-controls={`${id}-fields`} onClick={() => setEditing((v) => !v)}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <span>
                <strong>{fill(lt.summary, { in: d(query.checkIn), out: d(query.checkOut), n: nights })}</strong>
                <span>{fill(lt.guests, { a: query.adults, c: query.children })} — {lt.change}</span>
              </span>
            </button>
            <div className="stay-list__fields" id={`${id}-fields`}>
              <label className="stay-list__field">
                <span>{ct.layout.checkIn}</span>
                <input type="date" required min={limits.min} max={limits.max} value={draft.checkIn}
                  onChange={(e) => { const v = e.currentTarget.value; setDraft((q) => ({ ...q, checkIn: v, checkOut: q.checkOut > v ? q.checkOut : addDays(v, 1) })); }} />
              </label>
              <label className="stay-list__field">
                <span>{ct.layout.checkOut}</span>
                <input type="date" required min={addDays(draft.checkIn, 1)} max={limits.max} value={draft.checkOut}
                  onChange={(e) => { const v = e.currentTarget.value; setDraft((q) => ({ ...q, checkOut: v })); }} />
              </label>
              <label className="stay-list__field stay-list__field--num">
                <span>{lt.adults}</span>
                <input type="number" inputMode="numeric" min={1} max={20} required value={draft.adults}
                  onChange={(e) => { const v = Math.max(1, Math.min(20, Number(e.currentTarget.value) || 1)); setDraft((q) => ({ ...q, adults: v })); }} />
              </label>
              <label className="stay-list__field stay-list__field--num">
                <span>{lt.children}</span>
                <input type="number" inputMode="numeric" min={0} max={20} value={draft.children}
                  onChange={(e) => { const v = Math.max(0, Math.min(20, Number(e.currentTarget.value) || 0)); setDraft((q) => ({ ...q, children: v })); }} />
              </label>
              <button type="submit" className="stay-list__go">{lt.search}</button>
            </div>
          </form>
        </div>
      </div>

      <div className="container stay-list__body">
        <div className="stay-list__tools">
          <div className="stay-list__chips" role="group" aria-label={lt.filter}>
            {chips.map(([k, label, n]) => (
              <button key={k} type="button" className="stay-list__chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {label} ({n})
              </button>
            ))}
          </div>
          <label className="stay-list__sort">
            <span>{lt.sort}</span>
            <select value={sort} onChange={(e) => setSort(e.currentTarget.value as typeof sort)}>
              <option value="RECOMMENDED">{lt.sortRecommended}</option>
              <option value="PRICE">{lt.sortPrice}</option>
            </select>
          </label>
        </div>

        <p className="stay-list__found" id={`${id}-found`} aria-live="polite">
          {!loading && !error && <><strong>{fill(lt.found, { n: freeCount })}</strong> <span>{lt.foundSub}</span></>}
        </p>

        {error && (
          <p className="stay-list__error" role="alert">{error} <button type="button" className="link-button" onClick={() => void load(query)}>{lt.retry}</button></p>
        )}
        {!error && !loading && rows.length > 0 && freeCount === 0 && <p className="stay-list__none">{lt.none}</p>}

        <ul className="stay-list__rows" aria-busy={loading || undefined}>
          {(loading || !data) && Array.from({ length: 3 }, (_, i) => <li key={i} className="stay-row skeleton" />)}
          {!loading && shown.map((r) => {
            const perks = r.promotions.flatMap((p) => [p.text, ...promoPerks(p, m, baht, locale.code)]).filter((x): x is string => !!x);
            const pick = r.kind === "HOUSE" ? lt.pickHouse : r.kind === "TENT" ? lt.pickTent : lt.pickCamping;
            return (
              <li key={r.key} className={`stay-row${r.free ? "" : " is-full"}`}>
                {r.cover
                  ? <ResponsiveImage image={r.cover} sizes={IMAGE_SIZES.card} className="stay-row__img" alt="" />
                  : <span className="stay-row__img stay-row__img--empty" />}
                <div className="stay-row__info">
                  <h3 className="stay-row__name">{r.details ? <Link to={r.details}>{r.name}</Link> : r.name}</h3>
                  <span className="stay-row__type">{r.kind === "HOUSE" ? lt.house : r.kind === "TENT" ? lt.tent : lt.camping}</span>
                  {r.capacity && <span className="stay-row__line">{fill(lt.capacity, { n: r.capacity.n, max: r.capacity.max })}</span>}
                  {r.text && <span className="stay-row__desc">{r.text}</span>}
                  {perks.length > 0 && (
                    <span className="stay-row__promo"><span className="promo__badge">{m.badge}</span> <span>{perks.join(" · ")}</span></span>
                  )}
                  {r.free && <span className="stay-row__ok">✓ {lt.instant}</span>}
                  {r.scarcity && <span className="stay-row__left">{r.scarcity}</span>}
                  {r.why && <span className="stay-row__left">{r.why}</span>}
                </div>
                <div className="stay-row__price">
                  <span className="stay-row__for">{fill(lt.priceFor, { n: nights, a: query.adults })}</span>
                  {r.list !== null && <s className="stay-row__was">{baht(r.list)}</s>}
                  <span className="stay-row__total">{baht(r.total)}</span>
                  {(r.free || r.details) && (
                    <div className="stay-row__action">
                      {r.free && <Link to={r.href} className="button button--primary stay-row__pick">{pick} ›</Link>}
                      {r.details && <Link to={r.details} className="button button--secondary stay-row__details">{t.accommodation.viewDetails}</Link>}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
