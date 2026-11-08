import { useEffect, useState } from "react";
import type { AvailabilityDto, PublicAccommodationsDto } from "../../shared/accommodation-types.ts";
import { STAY_RULES } from "../../shared/booking-rules.ts";
import { addDays, diffDays, todayIn, DEFAULT_TIMEZONE } from "../../shared/dates.ts";
import type { Messages } from "../../shared/i18n/index.ts";
import { ApiError, apiGet } from "../api/client.ts";

/** Loads published houses / VIP tents / camping for the current language. */
export function useAccommodations(lang: string) {
  const [data, setData] = useState<PublicAccommodationsDto | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    apiGet<PublicAccommodationsDto>(`/api/public/accommodations?lang=${encodeURIComponent(lang)}`, controller.signal)
      .then(setData)
      .catch(() => !controller.signal.aborted && setError(true));
    return () => controller.abort();
  }, [lang]);
  return { data, error };
}

export interface StayQuery {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  tents: number;
}

export function defaultStay(): StayQuery {
  const today = todayIn(DEFAULT_TIMEZONE);
  return { checkIn: addDays(today, 1), checkOut: addDays(today, 2), adults: 2, children: 0, tents: 1 };
}

export function guestsOf(q: StayQuery): number {
  return q.adults + q.children;
}

export function stayLimits() {
  const today = todayIn(DEFAULT_TIMEZONE);
  return { min: today, max: addDays(today, STAY_RULES.maxAdvanceDays + STAY_RULES.maxNights) };
}

/** Live availability for a stay (never cached). Returns a localised error message on 422. */
export async function fetchAvailability(q: StayQuery, t: Messages): Promise<{ data?: AvailabilityDto; error?: string }> {
  const params = new URLSearchParams({ checkIn: q.checkIn, checkOut: q.checkOut, guests: String(guestsOf(q)), tents: String(q.tents) });
  try {
    return { data: await apiGet<AvailabilityDto>(`/api/public/availability?${params}`) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      const code = Object.values(err.details)[0] as keyof Messages["accommodation"]["errors"] | undefined;
      return { error: (code && t.accommodation.errors[code]) || t.accommodation.errors.INVALID_DATE };
    }
    return { error: t.common.loadError };
  }
}

const REMEMBER_KEY = "psk.stay";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The dates a guest searched (booking page or home list), kept for this tab: a house page opened after that
 * checks them by itself, so "เลือกที่พักนี้" is there without searching again.
 */
export function rememberStay(q: StayQuery): void {
  try { sessionStorage.setItem(REMEMBER_KEY, JSON.stringify(q)); } catch { /* storage off: they search again */ }
}

/** The remembered search, if its dates are still bookable (from today on); otherwise null. */
export function rememberedStay(): StayQuery | null {
  try {
    const raw = sessionStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const q = JSON.parse(raw) as Partial<StayQuery>;
    const { min, max } = stayLimits();
    if (typeof q.checkIn !== "string" || typeof q.checkOut !== "string" || !ISO.test(q.checkIn) || !ISO.test(q.checkOut)) return null;
    if (q.checkIn < min || q.checkOut <= q.checkIn || q.checkOut > max) return null;
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 50 ? v : d);
    return { checkIn: q.checkIn, checkOut: q.checkOut, adults: Math.max(1, n(q.adults, 2)), children: n(q.children, 0), tents: Math.max(1, n(q.tents, 1)) };
  } catch {
    return null;
  }
}

export function nightsBetween(q: StayQuery): number {
  return Math.max(0, diffDays(q.checkIn, q.checkOut));
}
