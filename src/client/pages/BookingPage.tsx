import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AvailabilityDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import type { FoodCatalogueDto, PublicBookingDto, QuoteDto, QuoteRequest } from "../../shared/booking-types.ts";
import { MAX_STAYS_PER_BOOKING } from "../../shared/booking-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { isIsoDate } from "../../shared/dates.ts";
import { campingItem, foodChangeEvents, quoteItems, unitItem } from "../analytics/booking-events.ts";
import { track } from "../analytics/tracker.ts";
import { readCampaign } from "../analytics/campaign.ts";
import { useBookingLayout, useSite } from "../site/SiteProvider.tsx";
import { useContentT } from "../content/useContentT.ts";
import { stayTotal, UnitRow } from "../accommodation/UnitRow.tsx";
import { ApiError } from "../api/client.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { defaultStay, fetchAvailability, rememberedPicks, rememberedStay, rememberPicks, rememberStay, useAccommodations, type KeptStay, type StayQuery } from "../accommodation/data.ts";
import { StaySearch } from "../accommodation/StaySearch.tsx";
import { fill, StayPrice, UnitCard, type Availability } from "../accommodation/UnitCard.tsx";
import { PromoList } from "../booking/Promotions.tsx";
import {
  addStaysToBooking,
  bookingErrorText,
  cartToSelections,
  createBooking,
  fetchFoodCatalogue,
  fetchBookingStatus,
  fetchQuote,
  newIdempotencyKey,
  type FoodCart,
} from "../booking/api.ts";
import { Confirmation } from "../booking/Confirmation.tsx";
import { FoodStep } from "../booking/FoodStep.tsx";
import { BookingSummary, useDateText } from "../booking/Summary.tsx";
import { CampingBooker } from "../booking/CampingBooker.tsx";
import { LandscapeMap } from "../booking/LandscapeMap.tsx";
import { guestsForNewUnit, pickKey, pickProblem, PicksBar, StayPicks, withAutoBeds, type Pick } from "../booking/StayPicks.tsx";
import { useBookingT } from "../booking/useBookingT.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";

type Step = "choose" | "food" | "details" | "review" | "done";
const WIZARD: Step[] = ["food", "details", "review"];

interface Details {
  name: string;
  phone: string;
  email: string;
  lineId: string;
  note: string;
}

/** ?checkIn=&checkOut=&adults=&children=&unit=<slug> — deep link from an accommodation page. */
function initialFromUrl(): { query: StayQuery; unitSlug: string | null; guestsGiven: boolean; searchNow: boolean } {
  const base = defaultStay();
  if (typeof window === "undefined") return { query: base, unitSlug: null, guestsGiven: false, searchNow: false };
  const p = new URLSearchParams(window.location.search);
  const int = (k: string, min: number, fallback: number) => {
    const n = Number(p.get(k));
    return Number.isInteger(n) && n >= min && n <= 50 ? n : fallback;
  };
  const checkIn = p.get("checkIn");
  const checkOut = p.get("checkOut");
  const valid = isIsoDate(checkIn) && isIsoDate(checkOut);
  // Back on the booking page (its link, the house page's "กลับไปหน้าจองที่พัก", the browser's back) without dates in
  // the address: the dates searched before in this tab, searched again at once.
  const remembered = valid ? null : rememberedStay();
  if (remembered) return { query: remembered, unitSlug: null, guestsGiven: false, searchNow: true };
  return {
    query: {
      checkIn: valid ? checkIn : base.checkIn,
      checkOut: valid ? checkOut : base.checkOut,
      adults: int("adults", 1, base.adults),
      children: p.has("children") ? int("children", 0, base.children) : base.children,
      tents: int("tents", 1, base.tents),
    },
    unitSlug: valid ? p.get("unit") : null,
    guestsGiven: p.has("adults") || p.has("children"),
    searchNow: false,
  };
}

/** Adding to a booking: what it already has, so a once-per-booking app fee (migration 0064) is priced right. */
function joining(body: QuoteRequest, addTo: PublicBookingDto | null): QuoteRequest {
  if (!addTo) return body;
  const stays = addTo.items.filter((i) => i.status !== "CANCELLED").reduce((acc, i) => acc + i.quantity, 0);
  return { ...body, joining: { stays, feeSatang: addTo.appFee?.totalSatang ?? 0 } };
}

export function BookingPage() {
  const { locale, t } = useI18n();
  const bt = useBookingT();
  const dateText = useDateText();
  const { data, error } = useAccommodations(locale.path);
  const [initial] = useState(initialFromUrl);
  const [query, setQuery] = useState<StayQuery>(initial.query);
  const [searched, setSearched] = useState<StayQuery | null>(null);
  const [availability, setAvailability] = useState<AvailabilityDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Settings → Theme → booking page (migration 0063): the list look's filter and order.
  const bookingLayout = useBookingLayout();
  const lt = useContentT().layout.list;
  const [kind, setKind] = useState<"ALL" | "HOUSE" | "TENT" | "CAMPING">("ALL");
  const [order, setOrder] = useState<"RECOMMENDED" | "PRICE">("RECOMMENDED");

  const [step, setStep] = useState<Step>("choose");
  /** The stays picked (several houses / VIP tents + camping, same dates), each with its own guests. */
  const [picks, setPicks] = useState<Pick[]>([]);
  const [catalogue, setCatalogue] = useState<FoodCatalogueDto | null>(null);
  const [cart, setCart] = useState<FoodCart>({});
  /** Health massage (migration 0050): treatment length id → people. */
  const [massages, setMassages] = useState<Record<string, number>>({});
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState<Details>({ name: "", phone: "", email: "", lineId: "", note: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [privacy, setPrivacy] = useState(false);
  const [idemKey, setIdemKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState<PublicBookingDto | null>(null);
  /** "จองเพิ่ม" before paying: the unpaid booking the new stays will join (its dates are kept). */
  const [addTo, setAddTo] = useState<PublicBookingDto | null>(null);
  /** Last tarp choice, kept when the guest goes back to change the stay. */
  const [campingTarp, setCampingTarp] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** False when online booking is paused (the site has run out of app credit); null while unknown. */
  const [onlineOpen, setOnlineOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchBookingStatus(controller.signal).then((r) => setOnlineOpen(r.open), () => undefined);
    return () => controller.abort();
  }, []);
  const { site } = useSite();
  /** Funnel steps sent once per chosen stay. */
  const sent = useRef({ viewFood: false, begin: false });

  /** `quiet`: the caller shows the error itself (camping form), not the search box at the top. */
  const searchSeq = useRef(0);
  const search = useCallback(async (q: StayQuery, quiet = false) => {
    const seq = ++searchSeq.current;
    setQuery(q);
    if (!quiet) setBusy(true);
    setSearchError(null);
    const result = await fetchAvailability(q, t);
    // A newer search went out meanwhile (e.g. the guest searched while the remembered dates were loading): its answer wins.
    if (seq !== searchSeq.current) return result;
    setBusy(false);
    setAvailability(result.data ?? null);
    setSearched(result.data ? q : null);
    if (result.data && !quiet) rememberStay(q);
    if (!quiet) setSearchError(result.error ?? null);
    return result;
  }, [t]);

  /** Camping form: spots left on its dates, without touching the search results above. */
  const peek = useCallback((q: StayQuery) => fetchAvailability(q, t), [t]);

  // The stays chosen before on these dates in this tab (read once, before this page's own choice is kept).
  const [kept] = useState(() => rememberedPicks(initial.query));

  /** Those stays again, for the houses still free (camping as it was; the price check says if it no longer fits). */
  function restorePicks(a: AvailabilityDto | undefined, all: PublicUnitDto[], except?: string): Pick[] {
    return kept.flatMap((k): Pick[] => {
      if (k.kind === "CAMPING") return data?.camping ? [k] : [];
      const unit = all.find((u) => u.slug === k.slug);
      if (!unit || unit.slug === except || !a?.units.some((s) => s.unitId === unit.id && s.available)) return [];
      return [{ kind: "UNIT", unit, adults: k.adults, children: k.children, ...(k.extraBeds ? { extraBeds: k.extraBeds } : {}), ...(k.pets ? { pets: k.pets } : {}) }];
    });
  }

  // Deep link: run the search once, then go on with the unit if it is free and takes the guests (more can be added later).
  // A house chosen on its own page joins the stays chosen before on the same dates.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !data || (!initial.unitSlug && !initial.searchNow)) return;
    autoRan.current = true;
    void search(initial.query).then(({ data: a }) => {
      const all = [...data.houses, ...data.vipTents];
      const before = restorePicks(a, all, initial.unitSlug ?? undefined);
      if (!initial.unitSlug) {
        if (before.length) setPicks(before);
        return;
      }
      const unit = all.find((u) => u.slug === initial.unitSlug);
      const state = a?.units.find((u) => u.unitId === unit?.id);
      if (!unit || !state?.available) {
        if (before.length) setPicks(before);
        return;
      }
      track({ name: "select_accommodation", item: unitItem(unit) });
      if (state.fitsGuests) start([...before, { kind: "UNIT", unit, adults: initial.query.adults, children: initial.query.children }], initial.query);
      else setPicks([...before, { kind: "UNIT", unit, ...guestsForNewUnit(unit, initial.query, before) }]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Keep the stays chosen (for a house page's "เลือกที่พักนี้" or coming back); forget them once booked.
  useEffect(() => {
    if (addTo || !searched || !autoRan.current && (initial.unitSlug || initial.searchNow)) return;
    if (step === "done") { rememberPicks(searched, []); return; }
    rememberPicks(searched, picks.map((p): KeptStay => (p.kind === "UNIT"
      ? { kind: "UNIT", slug: p.unit.slug, adults: p.adults, children: p.children, ...(p.extraBeds ? { extraBeds: p.extraBeds } : {}), ...(p.pets ? { pets: p.pets } : {}) }
      : { kind: "CAMPING", tents: p.tents, tarp: p.tarp, adults: p.adults, children: p.children })));
  }, [picks, searched, step, addTo, initial]);

  const request = useCallback((q: StayQuery, chosen: Pick[], foodCart: FoodCart, massageCart: Record<string, number> = {}): QuoteRequest => ({
    checkIn: q.checkIn,
    checkOut: q.checkOut,
    adults: chosen.reduce((acc, p) => acc + p.adults, 0),
    children: chosen.reduce((acc, p) => acc + p.children, 0),
    // Every stay with its own guests, on the same dates.
    stays: chosen.map((p) => (p.kind === "UNIT"
      ? { kind: "UNIT", unitId: p.unit.id, adults: p.adults, children: p.children, ...(p.extraBeds ? { extraBeds: p.extraBeds } : {}), ...(p.pets ? { pets: p.pets } : {}) }
      : { kind: "CAMPING", tents: p.tents, ...(p.tarp ? { tarp: true } : {}), adults: p.adults, children: p.children })),
    food: cartToSelections(foodCart, (id) => catalogue?.categories.some((cat) => cat.options.some((o) => o.id === id && o.pricingType === "PER_PERSON")) ?? false),
    ...(Object.values(massageCart).some((n) => n > 0)
      ? { massages: Object.entries(massageCart).filter(([, n]) => n > 0).map(([optionId, quantity]) => ({ optionId, quantity })) } : {}),
    lang: locale.code,
  }), [catalogue, locale.code]);

  // Live server-side price whenever the selection changes (debounced).
  useEffect(() => {
    if (!picks.length || !searched || step === "choose" || step === "done") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setQuoting(true);
      fetchQuote(joining(request(searched, picks, cart, massages), addTo), controller.signal)
        .then((q) => { setQuote(q); setNotice(null); })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setNotice(bookingErrorText(bt, err));
          // Extra beds switched off meanwhile: take them off (the price comes back without them) and stop offering them.
          if (err instanceof ApiError && err.code === "EXTRA_BED_UNAVAILABLE") dropExtraBeds();
          if (err instanceof ApiError && err.code === "PET_UNAVAILABLE") dropPets();
          // Massage switched off or the menu changed: clear the choice, show the current menu.
          if (err instanceof ApiError && (err.code === "MASSAGE_UNAVAILABLE" || Object.keys(err.details).some((k) => k.startsWith("massages")))) {
            setMassages({});
            fetchFoodCatalogue(searched.checkIn, searched.checkOut, locale.code).then(setCatalogue).catch(() => undefined);
          }
        })
        .finally(() => { if (!controller.signal.aborted) setQuoting(false); });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [picks, searched, cart, massages, step, request, bt, locale.code, addTo]);

  useEffect(() => {
    if (step !== "choose") headingRef.current?.focus();
  }, [step]);

  /** No extra beds any more (the property switched them off): off every stay and off the page. */
  function dropExtraBeds() {
    setPicks((cur) => (cur.some((p) => p.kind === "UNIT" && p.extraBeds) ? cur.map((p) => (p.kind === "UNIT" ? { ...p, extraBeds: 0 } : p)) : cur));
    setCatalogue((c) => (c ? { ...c, extraBed: null } : c));
  }

  /** Massage switched off or the menu changed: clear the choice and fetch the menu again. */
  function dropMassage() {
    setMassages({});
    if (searched) fetchFoodCatalogue(searched.checkIn, searched.checkOut, locale.code).then(setCatalogue).catch(() => undefined);
  }

  /** Pets no longer allowed (the property switched them off): off every stay and off the page. */
  function dropPets() {
    setPicks((cur) => (cur.some((p) => p.kind === "UNIT" && p.pets) ? cur.map((p) => (p.kind === "UNIT" ? { ...p, pets: 0 } : p)) : cur));
    setCatalogue((c) => (c ? { ...c, pet: null } : c));
  }

  const trackItem = (p: Pick) => (p.kind === "UNIT" ? unitItem(p.unit) : campingItem(data?.camping ?? null, t.accommodation.camping, p.tents));

  /** Add a house / VIP tent to the stays (guests: whoever the search asked for and no other stay holds yet). */
  function addUnit(unit: PublicUnitDto) {
    // One booking holds at most MAX_STAYS_PER_BOOKING stays: say so here, not as an error later.
    if (!picks.some((p) => pickKey(p) === unit.id) && picks.length >= MAX_STAYS_PER_BOOKING) {
      setNotice(bt.errors.TOO_MANY_STAYS);
      return;
    }
    track({ name: "select_accommodation", item: unitItem(unit) });
    // Guests: the ones a link brought (e.g. from a house page), split over the stays; else the house's usual number
    // (the search asks dates only) — changed per stay in the list.
    const guests = initial.guestsGiven ? guestsForNewUnit(unit, searched ?? query, picks)
      : { adults: Math.max(1, Math.min(unit.standardGuests, unit.maxAdults ?? unit.maxGuests, unit.maxGuests)), children: 0 };
    setPicks((cur2) => [...cur2.filter((p) => pickKey(p) !== unit.id), { kind: "UNIT", unit, ...guests }]);
  }

  /** "เลือกที่พักเพิ่ม": back to the list with the stays chosen so far (and the extras picked) kept. */
  const keepExtras = useRef(false);
  function chooseMore() {
    keepExtras.current = true;
    setStep("choose");
    window.setTimeout(() => {
      const list = document.getElementById("stay-list");
      list?.scrollIntoView({ block: "start" });
      list?.focus({ preventScroll: true });
    }, 0);
  }

  /** Start the booking steps with these stays. */
  function start(chosen: Pick[], q: StayQuery = searched ?? query) {
    const keep = keepExtras.current && searched !== null && q.checkIn === searched.checkIn && q.checkOut === searched.checkOut;
    keepExtras.current = false;
    sent.current = { viewFood: false, begin: false };
    const items = chosen.map(trackItem);
    // Indicative value (one night); the exact total is known at checkout.
    track({ name: "begin_booking", value: chosen.reduce((acc, p, i) => acc + (items[i]!.price ?? 0) * (p.kind === "UNIT" ? 1 : p.adults), 0), items });
    setPicks(chosen);
    setNotice(null);
    setStep("food");
    window.scrollTo({ top: 0 });
    // Back from "เลือกที่พักเพิ่ม" on the same dates: the food, extra beds and massage chosen stay.
    if (keep && catalogue) return;
    setCart({});
    setMassages({});
    setQuote(null);
    setCatalogue(null);
    fetchFoodCatalogue(q.checkIn, q.checkOut, locale.code)
      .then(setCatalogue)
      .catch(() => setCatalogue({ checkIn: q.checkIn, checkOut: q.checkOut, categories: [] }));
  }

  // More guests than a house's usual number: its extra beds are added on their own (when the property offers them).
  useEffect(() => {
    if (!catalogue?.extraBed) return;
    setPicks((cur) => withAutoBeds(cur, catalogue.extraBed));
  }, [catalogue, picks]);

  useEffect(() => {
    if (step !== "food" || !catalogue || sent.current.viewFood) return;
    sent.current.viewFood = true;
    track({ name: "view_food" });
  }, [step, catalogue]);

  function go(target: Step) {
    // Adding to a booking: its guest details are kept, so no details step.
    const next: Step = addTo && target === "details" ? (step === "review" ? "food" : "review") : target;
    if (next === "details" && quote && !sent.current.begin) {
      sent.current.begin = true;
      track({ name: "begin_checkout", value: quote.totalSatang / 100, items: quoteItems(quote) });
    }
    if (next === "review") setIdemKey(newIdempotencyKey());
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  async function confirm() {
    if (!picks.length || !searched || !quote || !idemKey) return;
    if (!privacy && !addTo) {
      setFieldErrors({ privacyAccepted: bt.errors.MUST_ACCEPT });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      if (addTo) {
        const updated = await addStaysToBooking({
          ...request(searched, picks, cart, massages),
          bookingCode: addTo.bookingCode,
          phone: details.phone,
          expectedTotalSatang: quote.totalSatang,
          idempotencyKey: idemKey,
        });
        setBooking(updated);
        setAddTo(null);
        setStep("done");
        window.scrollTo({ top: 0 });
        return;
      }
      const created = await createBooking({
        ...request(searched, picks, cart, massages),
        customer: {
          name: details.name,
          phone: details.phone,
          ...(details.email.trim() ? { email: details.email.trim() } : {}),
          ...(details.lineId.trim() ? { lineId: details.lineId.trim() } : {}),
          ...(details.note.trim() ? { note: details.note.trim() } : {}),
        },
        privacyAccepted: true,
        expectedTotalSatang: quote.totalSatang,
        idempotencyKey: idemKey,
        attribution: readCampaign(),
      });
      setBooking(created);
      // Lead: same event_id as the server copy (Conversions API) → Meta keeps one.
      track({ name: "generate_lead", bookingCode: created.bookingCode, value: created.totalSatang / 100 });
      setStep("done");
      window.scrollTo({ top: 0 });
    } catch (err) {
      const text = bookingErrorText(bt, err);
      if (err instanceof ApiError && (err.code === "BOOKING_NOT_ADDABLE" || err.code === "BOOKING_NOT_FOUND")) {
        // Paid, slip sent or time over meanwhile: nothing was added; back to the booking as it is.
        setNotice(text);
      } else if (err instanceof ApiError && err.code === "PRICE_CHANGED") {
        setNotice(bt.priceChanged);
        setQuote(await fetchQuote(joining(request(searched, picks, cart, massages), addTo)).catch(() => quote));
        setIdemKey(newIdempotencyKey());
      } else if (err instanceof ApiError && (err.code === "EXTRA_BED_UNAVAILABLE" || err.code === "PET_UNAVAILABLE" || err.code === "MASSAGE_UNAVAILABLE")) {
        if (err.code === "EXTRA_BED_UNAVAILABLE") dropExtraBeds();
        else if (err.code === "PET_UNAVAILABLE") dropPets();
        else dropMassage();
        setNotice(text);
        setStep("food");
        window.scrollTo({ top: 0 });
      } else if (err instanceof ApiError && ["UNIT_UNAVAILABLE", "CAMPING_FULL", "ACCOMMODATION_NOT_FOUND", "CAMPING_UNAVAILABLE", "TARP_FULL", "TARP_UNAVAILABLE"].includes(err.code)) {
        // Back to the stays: the one just taken goes (the others stay picked).
        setStep("choose");
        const gone = err.details.unitId;
        setPicks((cur) => (gone ? cur.filter((p) => pickKey(p) !== gone)
          : err.code.startsWith("CAMPING") || err.code.startsWith("TARP") ? cur.filter((p) => p.kind !== "CAMPING") : []));
        void search(searched);
        setSearchError(text);
      } else if (err instanceof ApiError && Object.keys(err.details).some((k) => k.startsWith("customer."))) {
        const errors = bt.errors as Record<string, string>;
        setFieldErrors(Object.fromEntries(Object.entries(err.details).map(([k, c]) => [k.replace("customer.", ""), errors[c] ?? text])));
        setStep("details");
      } else if (err instanceof ApiError && (err.code === "FOOD_CAPACITY_EXCEEDED" || Object.keys(err.details).some((k) => k.startsWith("food")))) {
        setNotice(text);
        setStep("food");
        if (searched) fetchFoodCatalogue(searched.checkIn, searched.checkOut, locale.code).then(setCatalogue).catch(() => undefined);
      } else {
        setNotice(text);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** "จองเพิ่ม" on an unpaid booking: choose more stays on its dates; they join it (same Booking ID and details). */
  function addMore(b: PublicBookingDto) {
    setAddTo(b);
    setStep("choose");
    setPicks([]);
    setQuote(null);
    setCart({});
    setMassages({});
    setNotice(null);
    const q = { ...(searched ?? query), checkIn: b.checkIn, checkOut: b.checkOut };
    void search(q);
    window.scrollTo({ top: 0 });
  }

  /** Back to the booking without adding anything. */
  function leaveAdd() {
    if (!addTo) return;
    setBooking(addTo);
    setAddTo(null);
    setPicks([]);
    setNotice(null);
    setStep("done");
    window.scrollTo({ top: 0 });
  }

  function restart() {
    setAddTo(null);
    setStep("choose");
    setPicks([]);
    setBooking(null);
    setQuote(null);
    setCart({});
    setMassages({});
    setPrivacy(false);
    setAvailability(null);
    setSearched(null);
  }

  // A unit too small for the whole group can still be one of several stays: free is enough here.
  const availabilityFor = (unit: PublicUnitDto): Availability => {
    const a = availability?.units.find((u) => u.unitId === unit.id);
    return a ? { available: a.available, fitsGuests: true, nightlyPricesSatang: a.nightlyPricesSatang, listPricesSatang: a.listPricesSatang, promotions: a.promotions } : null;
  };

  // ------------------------------------------------------------------ confirmation
  // A link to …/booking#sec-camping (the home page's stay list) lands on the camping ground once it is drawn.
  const campingShown = !!data?.camping.enabled;
  useEffect(() => {
    if (campingShown && typeof window !== "undefined" && window.location.hash === "#sec-camping") {
      document.getElementById("sec-camping")?.scrollIntoView({ block: "start" });
    }
  }, [campingShown]);

  if (step === "done" && booking) {
    return (
      <div className="page container">
        <Confirmation booking={booking} phone={details.phone} headingRef={headingRef} onNewBooking={restart} onAddMore={addMore} />
      </div>
    );
  }

  // ------------------------------------------------------------------ wizard
  if (step !== "choose" && picks.length && searched) {
    const wizard: Step[] = addTo ? ["food", "review"] : WIZARD;
    const index = wizard.indexOf(step);
    const stepLabels = addTo ? [bt.stepFood, bt.stepReview, bt.stepPay] : [bt.stepFood, bt.stepDetails, bt.stepReview, bt.stepPay];
    const titles: Record<string, string> = { food: bt.foodTitle, details: bt.stepDetails, review: bt.stepReview };
    const campingName = data?.camping.name ?? t.accommodation.camping;
    const submitDetails = (e: FormEvent) => {
      e.preventDefault();
      setFieldErrors({});
      go("review");
    };

    return (
      <div className="page container booking-flow">
        <ol className="flow-steps" aria-label={fill(bt.progress, { n: index + 1, total: wizard.length + 1 })}>
          {/* The payment step follows on the confirmation page, once the booking holds the stay. */}
          {stepLabels.map((label, i) => (
            <li key={label} className={i < index ? "is-done" : i === index ? "is-current" : undefined} aria-current={i === index ? "step" : undefined}>
              <span className="flow-steps__n" aria-hidden="true">{i + 1}</span> {label}
            </li>
          ))}
        </ol>

        <section className="flow-stay" aria-label={bt.yourStay}>
          <div>
            {picks.map((p, i) => (
              <span key={pickKey(p)} className="flow-stay__item">
                {i > 0 && " + "}
                <strong>{p.kind === "UNIT" ? p.unit.name : campingName}</strong>
                {p.kind === "CAMPING" && <> · {fill(bt.tentsLine, { n: p.tents })}{p.tarp && ` + ${bt.tarpLine}`}</>}
              </span>
            ))}
            <div className="flow-stay__meta">
              {fill(bt.stayLine, { checkIn: dateText(searched.checkIn), checkOut: dateText(searched.checkOut), n: quote?.nights ?? "" })}
              {" · "}
              {fill(bt.guestsLine, { adults: picks.reduce((a, p) => a + p.adults, 0), children: picks.reduce((a, p) => a + p.children, 0) })}
            </div>
          </div>
          <button type="button" className="button button--ghost" onClick={() => setStep("choose")}>{bt.change}</button>
        </section>

        <h1 className="page__title" tabIndex={-1} ref={headingRef}>{titles[step]}</h1>
        {step === "food" && (
          <p className="flow-add-more">
            <button type="button" className="button button--secondary" onClick={chooseMore}>+ {bt.addMoreStays}</button>
            <span className="flow-add-more__hint">{bt.addMoreHint}</span>
          </p>
        )}
        {addTo && <AddingBanner booking={addTo} onCancel={leaveAdd} />}
        {notice && <p role="alert" className="notice notice--error">{notice}</p>}
        {!notice && quote?.bookingUnavailable && step !== "done" && <p role="alert" className="notice notice--error">{bt.bookingUnavailable}</p>}

        <div className="flow-layout">
          <div className="flow-main">
            {step === "food" && (
              catalogue ? <FoodStep catalogue={catalogue} quote={quote} cart={cart} picks={picks}
                onExtraBeds={(unitId, n) => setPicks((cur) => cur.map((p) => (p.kind === "UNIT" && p.unit.id === unitId ? { ...p, extraBeds: n } : p)))}
                onPets={(unitId, n) => setPicks((cur) => cur.map((p) => (p.kind === "UNIT" && p.unit.id === unitId ? { ...p, pets: n } : p)))}
                massages={massages} onMassage={(optionId, n) => setMassages((cur) => ({ ...cur, [optionId]: n }))}
                onChange={(next) => { foodChangeEvents(cart, next, catalogue); setCart(next); }} />
                : <p role="status">{t.common.loading}</p>
            )}

            {step === "details" && (
              <form id="details-form" className="flow-form" onSubmit={submitDetails} noValidate={false}>
                <FormField id="bk-name" label={bt.name} required autoComplete="name" maxLength={100} value={details.name}
                  error={fieldErrors.name} onChange={(v) => setDetails({ ...details, name: v })} />
                {/* Exactly 10 digits: only digits are kept as the guest types (+66 becomes 0). */}
                <FormField id="bk-phone" label={bt.phone} required type="tel" inputMode="numeric" autoComplete="tel" maxLength={10}
                  pattern="0[0-9]{9}" title={bt.errors.PHONE_10_DIGITS}
                  hint={bt.phoneHint10} value={details.phone} error={fieldErrors.phone}
                  onChange={(v) => setDetails({ ...details, phone: v.replace(/^\+?66/, "0").replace(/\D/g, "").slice(0, 10) })} />
                {/* Required unless staff switched it off in booking rules (migration 0058). */}
                <FormField id="bk-email" label={data?.requireEmail ? bt.emailRequired : bt.email} required={!!data?.requireEmail} type="email"
                  inputMode="email" autoComplete="email" maxLength={254} value={details.email} hint={data?.requireEmail ? bt.emailHint : undefined}
                  error={fieldErrors.email} onChange={(v) => setDetails({ ...details, email: v })} />
                <FormField id="bk-line" label={bt.lineId} maxLength={50} value={details.lineId} error={fieldErrors.lineId}
                  onChange={(v) => setDetails({ ...details, lineId: v })} />
                <div className="form-field">
                  <label htmlFor="bk-note">{bt.note}</label>
                  <textarea id="bk-note" rows={3} maxLength={1000} value={details.note} onChange={(e) => setDetails({ ...details, note: e.target.value })} />
                </div>
              </form>
            )}

            {step === "review" && quote && addTo && (
              <div className="flow-review">
                <dl className="review-contact">
                  <div><dt>{bt.bookingCode}</dt><dd translate="no">{addTo.bookingCode}</dd></div>
                  <div><dt>{bt.name}</dt><dd>{addTo.customerName}</dd></div>
                  <div><dt>{bt.phone}</dt><dd>{addTo.customerPhoneMasked}</dd></div>
                </dl>
                <p className="notice" role="note">{bt.addReviewNote}</p>
                <section className="add-existing" aria-labelledby="add-existing-h">
                  <h2 id="add-existing-h" className="add-existing__title">{bt.addExistingTitle}</h2>
                  <BookingSummary quote={addTo} headingLevel={3} />
                </section>
              </div>
            )}
            {step === "review" && quote && !addTo && (
              <div className="flow-review">
                <dl className="review-contact">
                  <div><dt>{bt.name}</dt><dd>{details.name}</dd></div>
                  <div><dt>{bt.phone}</dt><dd>{details.phone}</dd></div>
                  {details.email && <div><dt>{bt.email}</dt><dd>{details.email}</dd></div>}
                  {details.lineId && <div><dt>{bt.lineId}</dt><dd>{details.lineId}</dd></div>}
                  {details.note && <div><dt>{bt.note}</dt><dd className="prose">{details.note}</dd></div>}
                </dl>
                <label className="check">
                  <input type="checkbox" checked={privacy} aria-invalid={fieldErrors.privacyAccepted ? true : undefined}
                    aria-describedby={fieldErrors.privacyAccepted ? "privacy-err" : undefined}
                    onChange={(e) => { setPrivacy(e.target.checked); setFieldErrors({}); }} />
                  <span>{bt.privacy}</span>
                </label>
                {site?.consent?.policyPath && (
                  // New tab: the guest keeps what they typed.
                  <p className="field-hint"><a href={site.consent.policyPath} target="_blank" rel="noopener">{t.footer.privacy}</a></p>
                )}
                {fieldErrors.privacyAccepted && <p id="privacy-err" className="field-error">{fieldErrors.privacyAccepted}</p>}
              </div>
            )}
          </div>

          <aside className="flow-aside">
            {addTo && <h2 className="add-existing__title">{bt.addNewTitle}</h2>}
            {quote ? <BookingSummary quote={quote} headingLevel={addTo ? 3 : 2} /> : <p role="status" className="summary">{bt.calculating}</p>}
            {addTo && quote && (
              <p className="add-total">
                <span>{bt.addNewTotal}</span>
                <strong>{formatBaht(addTo.totalSatang + quote.totalSatang, locale.code)}</strong>
              </p>
            )}
            {quoting && quote && <p className="flow-aside__busy" role="status">{bt.calculating}</p>}
          </aside>
        </div>

        <div className="flow-nav">
          <button type="button" className="button button--secondary"
            onClick={() => (index === 0 ? setStep("choose") : go(wizard[index - 1]!))}>
            ← {bt.back}
          </button>
          {step === "food" && <button type="button" className="button button--primary" disabled={!quote || quoting || !!quote.bookingUnavailable} onClick={() => go("details")}>{bt.next} →</button>}
          {step === "details" && <button type="submit" form="details-form" className="button button--primary">{bt.next} →</button>}
          {step === "review" && (
            <button type="button" className="button button--primary" disabled={!quote || quoting || submitting || !!quote.bookingUnavailable} aria-busy={submitting || undefined}
              onClick={() => void confirm()}>
              {submitting ? bt.confirming : addTo
                ? `${bt.addConfirm} · ${quote ? formatBaht(addTo.totalSatang + quote.totalSatang, locale.code) : ""}`
                : `${bt.confirm} · ${quote ? formatBaht(quote.totalSatang, locale.code) : ""}`}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ choose
  const empty = data && data.houses.length === 0 && data.vipTents.length === 0 && !data.camping.enabled;
  const canBook = (unit: PublicUnitDto) => !!availabilityFor(unit)?.available;
  const picked = (unit: PublicUnitDto) => picks.some((p) => pickKey(p) === unit.id);
  const ready = picks.length > 0 && picks.reduce((a, p) => a + p.adults, 0) >= 1 && picks.every((p) => pickProblem(p, bt) === null);
  /** One house / VIP tent with its choose / remove button: in the list, and in the site map's panel. */
  const pickButton = (u: PublicUnitDto) => canBook(u) && (picked(u) ? (
    <button type="button" className="button button--secondary unit-pick__btn" aria-pressed="true"
      onClick={() => setPicks((cur) => cur.filter((p) => pickKey(p) !== u.id))}>
      {bt.picked} · {bt.pickRemove}
    </button>
  ) : (
    <button type="button" className="button button--primary unit-pick__btn" aria-pressed="false" onClick={() => addUnit(u)}>
      {picks.length ? bt.pickAddMore : bt.pickAdd}
    </button>
  ));
  const unitPick = (u: PublicUnitDto) => (
    <div key={u.id} className={`unit-pick${picked(u) ? " is-picked" : ""}`}>
      <UnitCard unit={u} availability={availabilityFor(u)} />
      {pickButton(u)}
    </div>
  );
  // The list look: houses and VIP tents in one list (type filter, order), free ones first after a search.
  const asList = bookingLayout === "LIST";
  const listed = data ? [
    ...data.houses.map((u, i) => ({ u, kind: "HOUSE" as const, i })),
    ...data.vipTents.map((u, i) => ({ u, kind: "TENT" as const, i: data.houses.length + i })),
  ] : [];
  const free = (u: PublicUnitDto) => { const a = availabilityFor(u); return !!a && a.available && a.fitsGuests; };
  const rows = listed
    .filter((r) => kind === "ALL" || r.kind === kind)
    .sort((a, b) => (availability ? Number(free(b.u)) - Number(free(a.u)) : 0)
      || (order === "PRICE" ? (stayTotal(availabilityFor(a.u)) ?? a.u.priceSatang) - (stayTotal(availabilityFor(b.u)) ?? b.u.priceSatang) : a.i - b.i));
  const showCamping = !asList || kind === "ALL" || kind === "CAMPING";
  const freeCount = listed.filter((r) => free(r.u)).length + (availability?.camping.enabled && availability.camping.remaining > 0 ? 1 : 0);
  const chips: ["ALL" | "HOUSE" | "TENT" | "CAMPING", string, number][] = data ? [
    ["ALL", lt.all, listed.length + (data.camping.enabled ? 1 : 0)],
    ...([["HOUSE", lt.house, data.houses.length], ["TENT", lt.tent, data.vipTents.length], ["CAMPING", lt.camping, data.camping.enabled ? 1 : 0]] as
      ["HOUSE" | "TENT" | "CAMPING", string, number][]).filter((c) => c[2] > 0),
  ] : [];
  const unitGrid = (units: PublicUnitDto[]) => <div className="unit-grid">{units.map(unitPick)}</div>;
  const campingPick = picks.find((p) => p.kind === "CAMPING");
  const goToCamping = () => document.getElementById("sec-camping")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className={`page container${picks.length ? " has-picks-bar" : ""}${asList ? " booking-page--list" : ""}`}>
      <div className="booking-head">
        <div className="booking-head__text">
          <h1 className="page__title" tabIndex={-1} ref={headingRef}>{t.pages.booking.title}</h1>
          <p className="page__lead">{t.accommodation.chooseDates}</p>
        </div>
      </div>
      {onlineOpen === false && <p className="notice notice--error" role="alert">{bt.onlineClosed}</p>}
      {addTo && <AddingBanner booking={addTo} onCancel={leaveAdd} onSeparate={restart} />}
      {addTo && searchError && <p role="alert" className="notice notice--error">{searchError}</p>}

      {!addTo && <StaySearch initial={query} busy={busy} error={searchError} showGuests={false} showTents={false}
        onSearch={(q) => {
          // Other dates: what was picked may not be free then.
          if (searched && (q.checkIn !== searched.checkIn || q.checkOut !== searched.checkOut)) setPicks([]);
          void search(q);
        }} />}
      {!availability && !addTo && <p className="notice" role="note">{bt.searchFirst}</p>}
      {notice === bt.errors.TOO_MANY_STAYS && <p role="alert" className="notice notice--error">{notice}</p>}
      {picks.length > 0 && (
        <StayPicks picks={picks} camping={data?.camping ?? null} campingName={data?.camping.name ?? t.accommodation.camping}
          onChange={setPicks} onEditCamping={goToCamping} onNext={() => start(picks)} />
      )}

      {error && <p role="alert" className="notice notice--error">{t.common.loadError}</p>}
      {!data && !error && <div className="unit-grid" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="unit-card unit-card--skeleton" />)}</div>}
      {empty && <EmptyState message={t.accommodation.noAccommodation} />}

      {data && !empty && (
        <LandscapeMap data={data} availability={availability} picks={picks} renderUnit={unitPick} onCamping={goToCamping} listId="stay-list" />
      )}
      <div id="stay-list" tabIndex={-1} className="stay-list-anchor" />

      {asList && data && listed.length > 0 && (
        <section aria-labelledby="sec-list" className="unit-section booking-list">
          <h2 id="sec-list" className="section-title">{lt.stays}</h2>
          <div className="stay-list__tools">
            <div className="stay-list__chips" role="group" aria-label={lt.filter}>
              {chips.map(([k, label, n]) => (
                <button key={k} type="button" className="stay-list__chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{label} ({n})</button>
              ))}
            </div>
            <label className="stay-list__sort">
              <span>{lt.sort}</span>
              <select value={order} onChange={(e) => setOrder(e.currentTarget.value as typeof order)}>
                <option value="RECOMMENDED">{lt.sortRecommended}</option>
                <option value="PRICE">{lt.sortPrice}</option>
              </select>
            </label>
          </div>
          {availability && <p className="stay-list__found" aria-live="polite"><strong>{fill(lt.found, { n: freeCount })}</strong> <span>{lt.foundSub}</span></p>}
          {rows.length > 0 && (
            <ul className="stay-list__rows">
              {rows.map(({ u, kind: k }) => (
                <li key={u.id}><UnitRow unit={u} kind={k} availability={availabilityFor(u)} picked={picked(u)} action={pickButton(u)} /></li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!asList && data && data.houses.length > 0 && (
        <section aria-labelledby="sec-houses" className="unit-section">
          <h2 id="sec-houses" className="section-title">{t.accommodation.houses}</h2>
          {unitGrid(data.houses)}
        </section>
      )}

      {!asList && data && data.vipTents.length > 0 && (
        <section aria-labelledby="sec-vip" className="unit-section">
          <h2 id="sec-vip" className="section-title">{t.accommodation.vipTents}</h2>
          {unitGrid(data.vipTents)}
        </section>
      )}

      {data && showCamping && (
        <section aria-labelledby="sec-camping" className="unit-section">
          <h2 id="sec-camping" className="section-title">{data.camping.name ?? t.accommodation.camping}</h2>
          <article className="camping-card">
            {data.camping.cover && <ResponsiveImage image={data.camping.cover} sizes={IMAGE_SIZES.half} className="camping-card__img" />}
            <div className="camping-card__body">
              {!data.camping.enabled ? (
                <p>{t.accommodation.campingDisabled}</p>
              ) : addTo?.items.some((i) => i.type === "OWN_TENT") ? (
                <p className="notice" role="note">{bt.addCampingAlready}</p>
              ) : (
                <>
                  {data.camping.description && <p className="prose">{data.camping.description}</p>}
                  <StayPrice base={data.camping.pricePerAdultNightSatang} nightly={availability?.camping.nightlyPricePerAdultSatang}
                    list={availability?.camping.listPricePerAdultSatang} per={t.accommodation.perAdultPerNight} totalSuffix={t.accommodation.perAdult} />
                  <PromoList promotions={availability?.camping.promotions} />
                  <p className="unit-card__meta">{fill(t.accommodation.childrenFree, { age: data.camping.childFreeUnderAge })}</p>
                  <CampingBooker camping={data.camping} initial={campingPick ? { ...(searched ?? query), adults: campingPick.adults, children: campingPick.children, tents: campingPick.tents } : searched ?? query}
                    initialTarp={campingPick ? campingPick.kind === "CAMPING" && campingPick.tarp : campingTarp}
                    label={campingPick ? bt.campingUpdate : picks.length ? bt.campingAdd : undefined} lockDates={!!addTo}
                    onCheck={(q) => search(q, true)} onPeek={peek}
                    onBook={(q, tarp) => {
                      setCampingTarp(tarp);
                      const pick: Pick = { kind: "CAMPING", tents: q.tents, tarp, adults: q.adults, children: q.children };
                      track({ name: "select_accommodation", item: trackItem(pick) });
                      // Camping alone: straight to the booking steps. With other stays: one more stay in the list.
                      const others = picks.filter((p) => p.kind !== "CAMPING");
                      if (others.length) {
                        setPicks([...others, pick]);
                        document.getElementById("picks")?.scrollIntoView({ behavior: "smooth", block: "start" });
                      } else start([pick], q);
                    }} />
                </>
              )}
            </div>
          </article>
        </section>
      )}
      {picks.length > 0 && <PicksBar picks={picks} ready={ready} onNext={() => start(picks)} />}
    </div>
  );
}

/** Adding stays to an unpaid booking: which one, its dates (fixed), and the way back. */
function AddingBanner({ booking, onCancel, onSeparate }: { booking: PublicBookingDto; onCancel: () => void; onSeparate?: () => void }) {
  const bt = useBookingT();
  const dateText = useDateText();
  return (
    <section className="add-banner" aria-label={bt.addBannerTitle}>
      <p className="add-banner__title">
        {fill(bt.addBannerTitleCode, { code: booking.bookingCode })}
      </p>
      <p className="add-banner__line">
        {fill(bt.stayLine, { checkIn: dateText(booking.checkIn), checkOut: dateText(booking.checkOut), n: booking.nights })}
        {" · "}{booking.customerName}
      </p>
      <p className="add-banner__hint">{bt.addBannerHint}</p>
      <p className="add-banner__actions">
        <button type="button" className="link-button" onClick={onCancel}>← {bt.addBack}</button>
        {onSeparate && <button type="button" className="link-button" onClick={onSeparate}>{bt.addSeparate}</button>}
      </p>
    </section>
  );
}

function FormField({
  id, label, hint, error, value, onChange, ...input
}: {
  id: string; label: string; hint?: string; error?: string; value: string; onChange: (v: string) => void;
  required?: boolean; type?: string; inputMode?: "tel" | "email" | "text" | "numeric"; autoComplete?: string; maxLength?: number;
  pattern?: string; title?: string;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}{input.required && <span aria-hidden="true"> *</span>}</label>
      <input id={id} {...input} value={value} onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
      {error && <p id={`${id}-err`} className="field-error">{error}</p>}
    </div>
  );
}
