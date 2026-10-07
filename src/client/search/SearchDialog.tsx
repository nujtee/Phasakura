import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatBaht } from "../../shared/booking-rules.ts";
import { getSearchMessages } from "../../shared/i18n/search-messages.ts";
import { track } from "../analytics/tracker.ts";
import { pagePath } from "../../shared/routes.ts";
import { SEARCH_ENTITY_TYPES, type SearchEntityType, type SearchResponseDto, type SearchResultDto } from "../../shared/search-types.ts";
import { apiGet, apiRequest } from "../api/client.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";

const DEBOUNCE_MS = 250;

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type State =
  | { kind: "idle" }
  | { kind: "loading"; previous: SearchResponseDto | null }
  | { kind: "done"; data: SearchResponseDto }
  | { kind: "error" };

/**
 * Global search (spec §40): words in any of the three languages, optional stay dates. With dates
 * the houses / VIP tents / camping are checked live and free ones come first. Modal <dialog>:
 * focus stays inside, Esc or the backdrop closes it, results are grouped by kind.
 */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { locale } = useI18n();
  const sm = getSearchMessages(locale.code);
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [q, setQ] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    if (!open && d.open) d.close();
    document.documentElement.classList.toggle("has-search", open);
    return () => document.documentElement.classList.remove("has-search");
  }, [open]);

  const datesSet = !!checkIn && !!checkOut;
  const datesInvalid = datesSet && checkOut <= checkIn;
  const words = q.trim();
  const ready = open && !datesInvalid && (words.length >= 2 || datesSet);

  useEffect(() => {
    if (!ready) {
      setState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setState((s) => ({ kind: "loading", previous: s.kind === "done" ? s.data : s.kind === "loading" ? s.previous : null }));
      const params = new URLSearchParams({ lang: locale.path });
      if (words) params.set("q", words);
      if (datesSet) { params.set("checkIn", checkIn); params.set("checkOut", checkOut); }
      apiGet<SearchResponseDto>(`/api/search?${params.toString()}`, controller.signal)
        .then((data) => setState({ kind: "done", data }))
        .catch(() => { if (!controller.signal.aborted) setState({ kind: "error" }); });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [ready, words, checkIn, checkOut, datesSet, locale.path, nonce]);

  const data = state.kind === "done" ? state.data : state.kind === "loading" ? state.previous : null;
  const results = data?.results ?? [];
  const groups = SEARCH_ENTITY_TYPES
    .map((type) => ({ type, items: results.filter((r) => r.type === type) }))
    .filter((g) => g.items.length);
  const hasStay = results.some((r) => r.type === "HOUSE" || r.type === "VIP_TENT" || r.type === "CAMPING");

  // "search" event (GA4 / Pixel, with consent): once per query, when submitted or a result is opened.
  const trackedTerm = useRef<string | null>(null);
  const trackSearch = (term: string | null | undefined) => {
    if (!term || trackedTerm.current === term) return;
    trackedTerm.current = term;
    track({ name: "search", term });
  };
  const opened = () => {
    if (data?.query) void apiRequest("POST", "/api/search/click", { q: data.query, lang: locale.code }).catch(() => undefined);
    trackSearch(data?.query);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    trackSearch(words);
    setNonce((n) => n + 1);
  };

  const status = state.kind === "loading" ? sm.searching
    : state.kind === "error" ? sm.error
      : state.kind === "done" ? (results.length ? fill(sm.count, { n: results.length }) : words ? fill(sm.empty, { q: words }) : sm.emptyDates)
        : "";

  return (
    <dialog ref={ref} className="search-dialog" aria-labelledby={`${id}-title`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      // One Esc closes the search (a search field would otherwise use the first one to clear itself).
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-dialog__panel">
        <h2 id={`${id}-title`} className="visually-hidden">{sm.label}</h2>
        <form role="search" className="search-form" onSubmit={submit} aria-label={sm.label}>
          <div className="search-form__row">
            <svg className="search-form__icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input ref={inputRef} type="search" className="search-form__input" value={q} maxLength={100} enterKeyHint="search"
              placeholder={sm.placeholder} aria-label={sm.label} aria-describedby={`${id}-hint`} autoComplete="off"
              onChange={(e) => setQ(e.currentTarget.value)} />
            <button type="button" className="search-form__close" onClick={onClose} aria-label={sm.close}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          </div>
          <details className="search-form__dates" open={datesSet || undefined}>
            <summary>{sm.dates}</summary>
            <div className="search-form__date-row">
              <label>
                <span>{sm.checkIn}</span>
                <input type="date" value={checkIn} min={localToday()} onChange={(e) => setCheckIn(e.currentTarget.value)} />
              </label>
              <label>
                <span>{sm.checkOut}</span>
                <input type="date" value={checkOut} min={checkIn || localToday()} onChange={(e) => setCheckOut(e.currentTarget.value)}
                  aria-invalid={datesInvalid || undefined} aria-describedby={datesInvalid ? `${id}-dates` : undefined} />
              </label>
              {(checkIn || checkOut) && (
                <button type="button" className="search-form__clear" onClick={() => { setCheckIn(""); setCheckOut(""); }}>{sm.clearDates}</button>
              )}
            </div>
            {datesInvalid && <p id={`${id}-dates`} className="search-form__error" role="alert">{sm.invalidDates}</p>}
          </details>
          <p id={`${id}-hint`} className="search-form__hint">{sm.hint}</p>
        </form>

        <p className="search-status" role="status" aria-live="polite">{status}</p>
        {state.kind === "done" && !results.length && words && <p className="search-empty">{sm.emptyTip}</p>}

        <div className={`search-results${state.kind === "loading" ? " is-loading" : ""}`}>
          {groups.map((g) => (
            <section key={g.type} className="search-group" aria-labelledby={`${id}-${g.type}`}>
              <h3 id={`${id}-${g.type}`} className="search-group__title">{sm.types[g.type as SearchEntityType]}</h3>
              <ul className="search-group__list">
                {g.items.map((r) => <Result key={`${r.type}:${r.id}`} r={r} onOpen={opened} />)}
              </ul>
            </section>
          ))}
          {datesSet && hasStay && (
            <Link to={`${pagePath(locale, "booking")}?checkIn=${checkIn}&checkOut=${checkOut}`} className="button button--primary search-book" onClick={opened}>
              {sm.bookDates}
            </Link>
          )}
        </div>
      </div>
    </dialog>
  );
}

function Result({ r, onOpen }: { r: SearchResultDto; onOpen: () => void }) {
  const { locale } = useI18n();
  const sm = getSearchMessages(locale.code);
  const a = r.availability;
  return (
    <li>
      <Link to={r.url} className={`search-result${a && !a.available ? " search-result--full" : ""}`} onClick={onOpen}>
        {r.image ? <ResponsiveImage image={r.image} sizes="72px" className="search-result__img" alt="" />
          : <span className="search-result__img search-result__img--empty" aria-hidden="true" />}
        <span className="search-result__text">
          <span className="search-result__title">{r.title}</span>
          {r.summary && <span className="search-result__summary">{r.summary}</span>}
          <span className="search-result__meta">
            {r.price && (
              <span className="search-result__price">
                {fill(sm.from, { price: formatBaht(r.price.satang, locale.code) })} {sm.per[r.price.per]}
              </span>
            )}
            {a && (
              <span className={`search-badge ${a.available ? "search-badge--ok" : "search-badge--no"}`}>
                {a.available ? (r.type === "CAMPING" && a.remaining !== null ? fill(sm.tentsLeft, { n: a.remaining }) : sm.available) : sm.unavailable}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}
