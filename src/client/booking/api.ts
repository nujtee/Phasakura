import type {
  CreateBookingRequest,
  FoodCatalogueDto,
  FoodSelection,
  PublicBookingDto,
  QuoteDto,
  QuoteRequest,
} from "../../shared/booking-types.ts";
import type { BookingMessages } from "../../shared/i18n/booking-messages.ts";
import { ApiError, apiGet, apiRequest } from "../api/client.ts";

export function fetchFoodCatalogue(checkIn: string, checkOut: string, lang: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ checkIn, checkOut, lang });
  return apiGet<FoodCatalogueDto>(`/api/public/food-options?${params}`, signal);
}

export function fetchQuote(body: QuoteRequest, signal?: AbortSignal) {
  return apiRequest<QuoteDto>("POST", "/api/public/bookings/quote", body, signal);
}

export function createBooking(body: CreateBookingRequest) {
  return apiRequest<PublicBookingDto>("POST", "/api/public/bookings", body);
}

export function lookupBooking(bookingCode: string, phone: string) {
  return apiRequest<PublicBookingDto>("POST", "/api/public/bookings/lookup", { bookingCode, phone });
}

/** Random key so a double click or retry cannot create two bookings. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Localised text for an API error: the first known field code, then the error code. */
export function bookingErrorText(bt: BookingMessages, error: unknown): string {
  const errors = bt.errors as Record<string, string>;
  if (error instanceof ApiError) {
    for (const code of Object.values(error.details)) if (errors[code]) return errors[code]!;
    if (errors[error.code]) return errors[error.code]!;
    if (error.status === 429) return bt.errors.TOO_MANY_REQUESTS;
    if (error.status === 0) return bt.errors.NETWORK;
  }
  return bt.errors.UNKNOWN;
}

/** Food selection keyed by "optionId|date". */
export type FoodCart = Record<string, { adults: number; children: number; quantity: number }>;

export function cartToSelections(cart: FoodCart, perPerson: (optionId: string) => boolean): FoodSelection[] {
  return Object.entries(cart).flatMap(([key, v]): FoodSelection[] => {
    const [optionId, serviceDate] = key.split("|") as [string, string];
    if (perPerson(optionId)) {
      return v.adults + v.children > 0 ? [{ optionId, serviceDate, adults: v.adults, children: v.children }] : [];
    }
    return v.quantity > 0 ? [{ optionId, serviceDate, quantity: v.quantity }] : [];
  });
}
