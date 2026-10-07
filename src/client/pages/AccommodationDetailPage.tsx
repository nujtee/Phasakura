import { useEffect, useState } from "react";
import type { AvailabilityDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { pagePath } from "../../shared/routes.ts";
import { ApiError, apiGet } from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { defaultStay, fetchAvailability, type StayQuery } from "../accommodation/data.ts";
import { StaySearch } from "../accommodation/StaySearch.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { useBookingT } from "../booking/useBookingT.ts";
import { NotFoundPage } from "./NotFoundPage.tsx";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";

/** /{lang}/accommodation/{slug} — details, photos, amenities and a live date check. */
export function AccommodationDetailPage({ slug }: { slug: string }) {
  const { locale, t } = useI18n();
  const [unit, setUnit] = useState<PublicUnitDto | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [result, setResult] = useState<AvailabilityDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [checked, setChecked] = useState<StayQuery | null>(null);
  const bt = useBookingT();

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    apiGet<PublicUnitDto>(`/api/public/accommodations/${encodeURIComponent(slug)}?lang=${locale.path}`, controller.signal)
      .then((u) => {
        setUnit(u);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState(err instanceof ApiError && err.status === 404 ? "missing" : "error");
      });
    return () => controller.abort();
  }, [slug, locale]);

  if (state === "missing") return <NotFoundPage />;
  if (state === "error") return <div className="page container"><p role="alert" className="notice notice--error">{t.common.loadError}</p></div>;
  if (!unit) return <div className="page container" aria-busy="true"><div className="detail-skeleton" /></div>;

  const images = unit.images.length ? unit.images : unit.cover ? [unit.cover] : [];
  const current = images[active];
  const mine = result?.units.find((u) => u.unitId === unit.id);

  async function check(q: StayQuery) {
    setChecked(q);
    setBusy(true);
    setSearchError(null);
    const r = await fetchAvailability(q, t);
    setBusy(false);
    setResult(r.data ?? null);
    setSearchError(r.error ?? null);
  }

  return (
    <article className="page container detail">
      <p className="detail__back"><Link to={pagePath(locale, "booking")}>← {t.accommodation.backToBooking}</Link></p>
      <h1 className="page__title">{unit.name}</h1>

      {images.length > 0 && (
        <section className="detail-gallery" aria-label={t.accommodation.photos}>
          {current && (
            <figure className="detail-gallery__main">
              <ResponsiveImage key={current.url} image={current} sizes={IMAGE_SIZES.hero} priority />
              {current.caption && <figcaption>{current.caption}</figcaption>}
            </figure>
          )}
          {images.length > 1 && (
            <ul className="detail-gallery__thumbs">
              {images.map((img, i) => (
                <li key={img.url}>
                  <button type="button" aria-label={`${t.accommodation.photos} ${i + 1}: ${img.alt}`}
                    aria-current={i === active ? "true" : undefined} onClick={() => setActive(i)}>
                    <ResponsiveImage image={img} sizes={IMAGE_SIZES.thumb} alt="" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="detail__layout">
        <div className="detail__main">
          {unit.shortDescription && <p className="page__lead">{unit.shortDescription}</p>}
          {unit.description && <p className="prose">{unit.description}</p>}
          {unit.amenities.length > 0 && (
            <section aria-labelledby="amenities-h">
              <h2 id="amenities-h" className="section-title">{t.accommodation.amenities}</h2>
              <ul className="amenity-list">{unit.amenities.map((a) => <li key={a.code}>{a.name}</li>)}</ul>
            </section>
          )}
        </div>

        <aside className="detail__aside" aria-labelledby="book-h">
          <p className="unit-card__price">
            <strong>{formatBaht(unit.priceSatang, locale.code)}</strong> <span>{t.accommodation.perNight}</span>
          </p>
          <p className="unit-card__meta">{fill(t.accommodation.upToGuests, { n: unit.maxGuests })}</p>
          <h2 id="book-h" className="section-title section-title--small">{t.accommodation.checkAvailability}</h2>
          <StaySearch initial={{ ...defaultStay(), adults: Math.min(2, unit.maxGuests) }} busy={busy} error={searchError}
            showTents={false} onSearch={(q) => void check(q)} />
          {mine && (
            <p className={`unit-card__badge-inline ${mine.available && mine.fitsGuests ? "is-ok" : "is-bad"}`} role="status">
              {!mine.available ? t.accommodation.unavailable : !mine.fitsGuests ? t.accommodation.tooManyGuests : t.accommodation.available}
            </p>
          )}
          {mine?.available && mine.fitsGuests && checked && (
            <Link className="button button--primary detail__book" to={`${pagePath(locale, "booking")}?${new URLSearchParams({
              unit: unit.slug, checkIn: checked.checkIn, checkOut: checked.checkOut, adults: String(checked.adults), children: String(checked.children),
            })}`}>
              {bt.select} →
            </Link>
          )}
        </aside>
      </div>
    </article>
  );
}
