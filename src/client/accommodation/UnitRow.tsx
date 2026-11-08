import type { ReactNode } from "react";
import type { PublicUnitDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { accommodationPath } from "../../shared/routes.ts";
import { PromoList, usePromo } from "../booking/Promotions.tsx";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";
import { useContentT } from "../content/useContentT.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { fill, type Availability } from "./UnitCard.tsx";

/** The total of the searched nights (null before a search): what the list sorts by and shows. */
export function stayTotal(availability: Availability): number | null {
  return availability?.nightlyPricesSatang?.length ? availability.nightlyPricesSatang.reduce((a, n) => a + n, 0) : null;
}

/**
 * One house / VIP tent as a row (booking page "list" look, migration 0063): photo, type, guests, promotions, whether
 * it is free for the dates, and the price for those nights on the right with the choose / remove button and
 * "ดูรายละเอียด" (the house's own page, as on the cards) below it.
 */
export function UnitRow({ unit, kind, availability, picked, action }: {
  unit: PublicUnitDto; kind: "HOUSE" | "TENT"; availability: Availability; picked: boolean; action: ReactNode;
}) {
  const { locale, t } = useI18n();
  const lt = useContentT().layout.list;
  const m = usePromo();
  const baht = (n: number) => formatBaht(n, locale.code);
  const total = stayTotal(availability);
  const nights = availability?.nightlyPricesSatang?.length ?? 0;
  const list = availability?.listPricesSatang?.length === nights && nights ? availability.listPricesSatang.reduce((a, n) => a + n, 0) : null;
  const free = !!availability && availability.available && availability.fitsGuests;
  const status = availability === null ? null
    : !availability.available ? lt.full
      : !availability.fitsGuests ? fill(lt.tooMany, { n: unit.maxGuests }) : null;
  return (
    <article className={`stay-row stay-row--pick${status ? " is-full" : ""}${picked ? " is-picked" : ""}`} aria-labelledby={`row-${unit.id}`}>
      {unit.cover
        ? <ResponsiveImage image={unit.cover} sizes={IMAGE_SIZES.card} className="stay-row__img" alt="" />
        : <span className="stay-row__img stay-row__img--empty" />}
      <div className="stay-row__info">
        <h3 className="stay-row__name" id={`row-${unit.id}`}><Link to={accommodationPath(locale, unit.slug)}>{unit.name}</Link></h3>
        <span className="stay-row__type">{kind === "HOUSE" ? lt.house : lt.tent}</span>
        <span className="stay-row__line">{fill(lt.capacity, { n: unit.standardGuests, max: unit.maxGuests })}</span>
        {unit.shortDescription && <span className="stay-row__desc">{unit.shortDescription}</span>}
        <PromoList promotions={availability?.promotions} />
        {free && <span className="stay-row__ok">✓ {lt.instant}</span>}
        {free && <span className="stay-row__left">{kind === "HOUSE" ? lt.leftHouse : lt.leftTent}</span>}
        {status && <span className="stay-row__left">{status}</span>}
      </div>
      <div className="stay-row__price">
        {total !== null ? (
          <>
            <span className="stay-row__for">{fill(lt.priceNights, { n: nights })}</span>
            {list !== null && list > total && <s className="stay-row__was"><span className="visually-hidden">{m.wasPrice} </span>{baht(list)}</s>}
            <span className="stay-row__total">{baht(total)}</span>
          </>
        ) : (
          <>
            <span className="stay-row__for">{lt.from}</span>
            <span className="stay-row__total">{baht(unit.priceSatang)}</span>
            <span className="stay-row__for">{t.accommodation.perNight}</span>
          </>
        )}
        <div className="stay-row__action">
          {action}
          <Link to={accommodationPath(locale, unit.slug)} className="button button--secondary stay-row__details">{t.accommodation.viewDetails}</Link>
        </div>
      </div>
    </article>
  );
}
