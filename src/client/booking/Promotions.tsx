import type { PromotionBriefDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import type { StayPromotionDto } from "../../shared/booking-types.ts";
import { getPromoMessages, type PromoMessages } from "../../shared/i18n/promo-messages.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** Guest-side promotion texts (migration 0055). */
export function usePromo(): PromoMessages {
  const { locale } = useI18n();
  return getPromoMessages(locale.code as Parameters<typeof getPromoMessages>[0]);
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

type PerkNames = { names: Partial<Record<string, string>> }[] | undefined;

/** A perk's name in this language, else Thai. */
export function perkNames(perks: PerkNames, lang: string): string[] {
  return (perks ?? []).map((k) => k.names[lang] ?? k.names.th ?? "").filter(Boolean);
}

/** What a promotion offers, in short words ("ลด 20%", "ฟรีที่นอนเสริม", "น้ำดื่ม 4 ขวด"…). */
export function promoPerks(p: Pick<PromotionBriefDto, "discount" | "freeExtraBed" | "freePets" | "freeFoodOptionIds" | "perks">, m: PromoMessages, baht: (n: number) => string, lang = "th"): string[] {
  return [
    p.discount?.kind === "PERCENT" ? fill(m.percentOff, { v: p.discount.value }) : null,
    p.discount?.kind === "AMOUNT" ? fill(m.amountOff, { v: baht(p.discount.value) }) : null,
    p.freeExtraBed ? m.freeExtraBed : null,
    p.freePets ? m.freePets : null,
    p.freeFoodOptionIds?.length ? m.freeFood : null,
    ...perkNames(p.perks, lang),
  ].filter((x): x is string => !!x);
}

/**
 * Promotions on a house card / the camping card / a house page: a badge, the owner's text and the perks,
 * optionally with the dates (house page: upcoming promotions).
 */
export function PromoList({ promotions, withDates = false, title }: { promotions?: PromotionBriefDto[] | null; withDates?: boolean; title?: string }) {
  const { locale } = useI18n();
  const m = usePromo();
  if (!promotions?.length) return null;
  const baht = (n: number) => formatBaht(n, locale.code);
  const day = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", timeZone: "UTC" });
  const d = (iso: string) => day.format(new Date(`${iso}T00:00:00Z`));
  return (
    <div className="promo">
      {title && <p className="promo__title">{title}</p>}
      <ul className="promo__list">
        {promotions.map((p, i) => (
          <li key={i} className="promo__item">
            <span className="promo__badge">{m.badge}</span>
            <span className="promo__body">
              {p.text && <span className="promo__text">{p.text}</span>}
              {promoPerks(p, m, baht, locale.code).length > 0 && <span className="promo__perks">{promoPerks(p, m, baht, locale.code).join(" · ")}</span>}
              {withDates && (
                <span className="promo__dates">
                  {p.dateFrom === p.dateTo ? fill(m.oneDate, { from: d(p.dateFrom) }) : fill(m.dates, { from: d(p.dateFrom), to: d(p.dateTo) })}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Bill / summary rows: one per promotion a stay got, with what it saved. */
export function PromoBillRows({ promotions }: { promotions?: StayPromotionDto[] | null }) {
  const { locale } = useI18n();
  const m = usePromo();
  if (!promotions?.length) return null;
  const baht = (n: number) => formatBaht(n, locale.code);
  return (
    <>
      {promotions.map((p, i) => {
        const parts = [
          p.roomDiscountSatang ? `${m.roomDiscount} −${baht(p.roomDiscountSatang)}` : null,
          p.extraBedFreeSatang ? `${m.extraBedFree} −${baht(p.extraBedFreeSatang)}` : null,
          p.petsFreeSatang ? `${m.petsFree} −${baht(p.petsFreeSatang)}` : null,
          p.foodFreeSatang ? `${m.foodFree} −${baht(p.foodFreeSatang)}` : null,
          ...perkNames(p.perks, locale.code),
        ].filter(Boolean);
        if (!p.text && !parts.length) return null;
        return (
          <li key={i} className="promo-bill">
            <span className="promo__badge">{m.badge}</span>{" "}
            {p.text && <span className="promo__text">{p.text}</span>}
            {parts.length > 0 && <span className="promo-bill__parts">{parts.join(" · ")}</span>}
          </li>
        );
      })}
    </>
  );
}

/** Is this dish free on this date for the chosen stays (a promotion night that day or the night before)? */
export function freeFoodOn(items: { promotions?: StayPromotionDto[] }[] | undefined, optionId: string, date: string): boolean {
  const prev = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return (items ?? []).some((it) => (it.promotions ?? []).some((p) =>
    p.freeFoodOptionIds?.includes(optionId) && (p.dates ?? []).some((d) => d === date || d === prev)));
}
