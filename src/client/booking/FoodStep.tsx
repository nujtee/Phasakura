import { MAX_MASSAGE_QUANTITY, type FoodCatalogueDto, type FoodOptionDto, type QuoteDto } from "../../shared/booking-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import type { FoodCart } from "./api.ts";
import type { Pick } from "./StayPicks.tsx";
import { useDateText } from "./Summary.tsx";
import { useBookingT } from "./useBookingT.ts";

/** − value + control. Buttons are 44px targets; the value is announced politely. */
export function Stepper({ label, caption, value, min, max, onChange }: {
  label: string; caption?: string; value: number; min: number; max: number; onChange: (n: number) => void;
}) {
  const bt = useBookingT();
  return (
    <div className="stepper" role="group" aria-label={label}>
      {caption && <span className="stepper__caption" aria-hidden="true">{caption}</span>}
      <button type="button" className="stepper__btn" aria-label={fill(bt.decrease, { what: label })} disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <output className="stepper__value" aria-live="polite">{value}</output>
      <button type="button" className="stepper__btn" aria-label={fill(bt.increase, { what: label })} disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}

function priceText(o: FoodOptionDto, bt: ReturnType<typeof useBookingT>, baht: (n: number) => string): string {
  const unit = o.pricingType === "PER_PERSON" ? bt.perPerson
    : o.pricingType === "PER_SET" ? fill(bt.perSet, { n: o.personsPerSet ?? 1 })
      : o.pricingType === "PER_NIGHT" ? bt.perNightFood : bt.perItem;
  let child = "";
  if (o.pricingType === "PER_PERSON") {
    if (o.childPricing === "FREE") child = ` · ${bt.childFree}`;
    else if (o.childPricing === "HALF") child = ` · ${bt.childHalf}`;
    else if (o.childPricing === "SPECIAL_PRICE" && o.childPriceSatang !== null) child = ` · ${fill(bt.childSpecial, { price: baht(o.childPriceSatang) })}`;
  }
  return `${baht(o.priceSatang)} ${unit}${child}`;
}

export function FoodStep({
  catalogue,
  quote,
  cart,
  onChange,
  picks = [],
  onExtraBeds,
  onPets,
  massages = {},
  onMassage,
}: {
  catalogue: FoodCatalogueDto;
  quote: QuoteDto | null;
  cart: FoodCart;
  onChange: (cart: FoodCart) => void;
  /** The stays chosen: extra beds are asked per house / VIP tent. */
  picks?: Pick[];
  onExtraBeds?: (unitId: string, n: number) => void;
  onPets?: (unitId: string, n: number) => void;
  /** Health massage (migration 0050): treatment length id → people. */
  massages?: Record<string, number>;
  onMassage?: (optionId: string, n: number) => void;
}) {
  const { locale } = useI18n();
  const bt = useBookingT();
  const dateText = useDateText();
  const baht = (s: number) => formatBaht(s, locale.code);
  const adults = quote?.adults ?? 1;
  const children = quote?.children ?? 0;

  const set = (key: string, patch: Partial<FoodCart[string]>) => {
    const current = cart[key] ?? { adults: 0, children: 0, quantity: 0 };
    onChange({ ...cart, [key]: { ...current, ...patch } });
  };

  const offer = catalogue.extraBed ?? null;
  const massage = catalogue.massage ?? null;
  const massageOptions = new Map((massage?.items ?? []).flatMap((i) => i.options.map((o) => [o.id, o] as const)));
  const massageCount = Object.entries(massages).filter(([id, n]) => n > 0 && massageOptions.has(id)).reduce((acc, [, n]) => acc + n, 0);
  const massageTotal = Object.entries(massages).reduce((acc, [id, n]) => acc + (massageOptions.get(id)?.priceSatang ?? 0) * n, 0);
  const pet = catalogue.pet ?? null;
  const units = picks.filter((p): p is Extract<Pick, { kind: "UNIT" }> => p.kind === "UNIT");
  // Extra beds only for houses where the owner left them on (migration 0047).
  const bedUnits = units.filter((p) => !(offer?.offUnitIds ?? []).includes(p.unit.id));

  return (
    <div className="food-step">
      {offer && onExtraBeds && bedUnits.length > 0 && (
        <section className="extra-beds" aria-labelledby="extra-beds-h">
          <h3 id="extra-beds-h">{bt.extraBedTitle}</h3>
          <p className="extra-beds__intro">
            {offer.pricePerNightSatang > 0
              ? fill(bt.extraBedIntro, { price: baht(offer.pricePerNightSatang), max: offer.maxPerUnit })
              : fill(bt.extraBedFree, { max: offer.maxPerUnit })}
          </p>
          {bedUnits.map((p) => (
            <div key={p.unit.id} className="food-option extra-beds__row">
              <div className="food-option__info">
                <strong>{p.unit.name}</strong>
                {(p.extraBeds ?? 0) > 0 && offer.pricePerNightSatang > 0 && quote && (
                  <span className="food-option__price">
                    {fill(bt.extraBedNights, { n: p.extraBeds ?? 0, nights: quote.nights })} = {baht((p.extraBeds ?? 0) * offer.pricePerNightSatang * quote.nights)}
                  </span>
                )}
              </div>
              <Stepper label={bedUnits.length > 1 ? `${bt.extraBedCount} · ${p.unit.name}` : bt.extraBedCount} value={p.extraBeds ?? 0} min={0}
                max={offer.maxPerUnit} onChange={(n) => onExtraBeds(p.unit.id, n)} />
            </div>
          ))}
        </section>
      )}
      {quote && quote.includedMeals.length > 0 && (
        <section className="food-included" aria-labelledby="incl-h">
          <h3 id="incl-h">{bt.includedTitle}</h3>
          <ul>
            {quote.includedMeals.map((m) => (
              <li key={m.categoryCode}>{fill(bt.includedLine, { name: m.name, n: m.personsPerNight, nights: m.nights })}</li>
            ))}
          </ul>
        </section>
      )}

      {pet && onPets && units.length > 0 && (
        <section className="extra-beds pets" aria-labelledby="pets-h">
          <h3 id="pets-h">{bt.petTitle}</h3>
          <p className="extra-beds__intro">
            {fill(pet.priceSatang === 0 ? bt.petIntroFree : pet.chargePer === "STAY" ? bt.petIntroStay : bt.petIntroNight,
              { price: baht(pet.priceSatang), kg: pet.maxWeightKg, max: pet.maxPerUnit })}
          </p>
          {units.map((p) => {
            const n = p.pets ?? 0;
            const times = pet.chargePer === "STAY" ? 1 : quote?.nights ?? 1;
            return (
              <div key={p.unit.id} className="food-option extra-beds__row">
                <div className="food-option__info">
                  <strong>{p.unit.name}</strong>
                  {n > 0 && pet.priceSatang > 0 && quote && (
                    <span className="food-option__price">
                      {pet.chargePer === "STAY" ? fill(bt.petStay, { n }) : fill(bt.petNights, { n, nights: quote.nights })} = {baht(n * pet.priceSatang * times)}
                    </span>
                  )}
                </div>
                <Stepper label={units.length > 1 ? `${bt.petCount} · ${p.unit.name}` : bt.petCount} value={n} min={0}
                  max={pet.maxPerUnit} onChange={(v) => onPets(p.unit.id, v)} />
              </div>
            );
          })}
        </section>
      )}

      {massage && onMassage && (
        <details className="extra-beds massage" open={massageCount > 0 || undefined}>
          <summary className="massage__summary">
            <span className="massage__head">
              <strong className="massage__title">{bt.massageTitle}</strong>
              <span className="extra-beds__intro">
                {massageCount > 0
                  ? fill(bt.massageChosen, { n: massageCount, price: baht(massageTotal) })
                  : fill(bt.massageIntro, { n: massage.items.length })}
              </span>
            </span>
            <span className="massage__toggle" aria-hidden="true">{bt.massageShow}</span>
          </summary>
          <ul className="massage__list">
            {massage.items.map((item) => (
              <li key={item.id} className="massage__item">
                <div className="massage__name">
                  <strong>{item.name}</strong>
                  {item.subName && <span className="massage__sub">{item.subName}</span>}
                </div>
                <div className="massage__options">
                  {item.options.map((o) => (
                    <div key={o.id} className="massage__option">
                      <span className="massage__price">{fill(bt.massageMinutes, { n: o.minutes })} · {baht(o.priceSatang)}</span>
                      <Stepper label={`${item.name} ${fill(bt.massageMinutes, { n: o.minutes })} · ${bt.massagePeople}`} caption={bt.massagePeople}
                        value={massages[o.id] ?? 0} min={0} max={MAX_MASSAGE_QUANTITY} onChange={(n) => onMassage(o.id, n)} />
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <p className="extra-beds__intro massage__note">{bt.massageNote}</p>
        </details>
      )}

      {((offer && onExtraBeds) || (pet && onPets) || (massage && onMassage)) && catalogue.categories.length > 0 && (
        <h3 className="food-step__section">{bt.foodSection}</h3>
      )}
      <p className="food-step__intro">{bt.foodIntro}</p>
      {catalogue.categories.length === 0 && <p className="notice">{bt.noFood}</p>}

      {catalogue.categories.map((c) => (
        <details key={c.id} className="food-cat" open={c.dates.some((d) => d.orderable)}>
          <summary>
            <span className="food-cat__name">{c.name}</span>
            {c.serviceTime && <span className="food-cat__time">{fill(bt.servedAt, { time: c.serviceTime })}</span>}
          </summary>
          {c.description && <p className="food-cat__desc">{c.description}</p>}
          {c.dates.map((d) => {
            const soldOut = d.remaining !== null && d.remaining <= 0;
            const usedHere = c.options.reduce((acc, o) => {
              const v = cart[`${o.id}|${d.date}`];
              return acc + (v ? (o.pricingType === "PER_PERSON" ? v.adults + v.children : v.quantity) : 0);
            }, 0);
            return (
              <fieldset key={d.date} className="food-day" disabled={!d.orderable || (soldOut && usedHere === 0)}>
                <legend>
                  {dateText(d.date)}
                  {!d.orderable ? <span className="food-day__tag">{bt.closed}</span>
                    : soldOut ? <span className="food-day__tag">{bt.soldOut}</span>
                      : d.remaining !== null && <span className="food-day__tag food-day__tag--ok">{fill(bt.remaining, { n: d.remaining })}</span>}
                </legend>
                {c.options.map((o) => {
                  const key = `${o.id}|${d.date}`;
                  const v = cart[key] ?? { adults: 0, children: 0, quantity: 0 };
                  const headroom = d.remaining === null ? Infinity : d.remaining - usedHere;
                  return (
                    <div key={o.id} className={`food-option${o.image ? " food-option--image" : ""}`}>
                      {o.image && <ResponsiveImage image={o.image} sizes={IMAGE_SIZES.thumb} className="food-option__img" alt="" />}
                      <div className="food-option__info">
                        <strong>{o.name}</strong>
                        <span className="food-option__price">{priceText(o, bt, baht)}</span>
                        {o.description && <span className="food-option__desc">{o.description}</span>}
                        {o.allergens && <span className="food-option__desc">⚠ {o.allergens}</span>}
                      </div>
                      {o.pricingType === "PER_PERSON" ? (
                        <div className="food-option__steppers">
                          <Stepper label={`${o.name} · ${bt.adults}`} caption={bt.adults} value={v.adults} min={0}
                            max={Math.min(adults, v.adults + Math.max(0, headroom))} onChange={(n) => set(key, { adults: n })} />
                          {children > 0 && (
                            <Stepper label={`${o.name} · ${bt.childrenShort}`} caption={bt.childrenShort} value={v.children} min={0}
                              max={Math.min(children, v.children + Math.max(0, headroom))} onChange={(n) => set(key, { children: n })} />
                          )}
                        </div>
                      ) : (
                        <Stepper label={`${o.name} · ${bt.quantity}`} value={v.quantity} min={0}
                          max={Math.min(o.maxQuantity ?? 20, v.quantity + Math.max(0, headroom))} onChange={(n) => set(key, { quantity: n })} />
                      )}
                    </div>
                  );
                })}
              </fieldset>
            );
          })}
        </details>
      ))}
    </div>
  );
}
