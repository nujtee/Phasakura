import type { PublicUnitDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { accommodationPath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
}

export type Availability = { available: boolean; fitsGuests: boolean } | null;

/** Card for one house / VIP tent. Availability badge only when a date search ran. */
export function UnitCard({ unit, availability }: { unit: PublicUnitDto; availability: Availability }) {
  const { locale, t } = useI18n();
  const status = availability === null ? null
    : !availability.available ? { cls: "unavailable", text: t.accommodation.unavailable }
      : !availability.fitsGuests ? { cls: "unavailable", text: t.accommodation.tooManyGuests }
        : { cls: "available", text: t.accommodation.available };

  return (
    <article className="unit-card" aria-labelledby={`unit-${unit.id}`}>
      <div className="unit-card__media">
        {unit.cover ? (
          <ResponsiveImage image={unit.cover} sizes={IMAGE_SIZES.card} />
        ) : (
          <div className="unit-card__placeholder" aria-hidden="true" />
        )}
        {status && <span className={`unit-card__badge unit-card__badge--${status.cls}`}>{status.text}</span>}
      </div>
      <div className="unit-card__body">
        <h3 id={`unit-${unit.id}`} className="unit-card__title">{unit.name}</h3>
        {unit.shortDescription && <p className="unit-card__desc">{unit.shortDescription}</p>}
        <p className="unit-card__meta">{fill(t.accommodation.upToGuests, { n: unit.maxGuests })}</p>
        <div className="unit-card__footer">
          <p className="unit-card__price">
            <strong>{formatBaht(unit.priceSatang, locale.code)}</strong> <span>{t.accommodation.perNight}</span>
          </p>
          <Link to={accommodationPath(locale, unit.slug)} className="button button--secondary">{t.accommodation.viewDetails}</Link>
        </div>
      </div>
    </article>
  );
}
