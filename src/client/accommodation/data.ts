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

export function nightsBetween(q: StayQuery): number {
  return Math.max(0, diffDays(q.checkIn, q.checkOut));
}
