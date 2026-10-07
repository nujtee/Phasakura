/**
 * Booking API contract shared by the Worker and the React app.
 * Money is always integer satang. Dates are YYYY-MM-DD business dates (Asia/Bangkok).
 */

import type { GuestLineDto } from "./line-types.ts";
import type { PaymentAccountSnapshotDto, PaymentDto, PaymentInstructionsDto } from "./payment-types.ts";

export type BookingItemType = "HOUSE" | "VIP_TENT" | "OWN_TENT";
export type BookingStatus = "PENDING" | "CONFIRMED" | "CHECKED_IN" | "CHECKED_OUT" | "CANCELLED" | "EXPIRED" | "NO_SHOW";
export type PaymentStatus = "UNPAID" | "PENDING_VERIFICATION" | "VERIFIED" | "PAID" | "REJECTED" | "REFUNDED";
export type FoodPricingType = "PER_PERSON" | "PER_SET" | "PER_ITEM" | "PER_NIGHT";
export type ChildPricing = "FREE" | "FULL" | "HALF" | "SPECIAL_PRICE";

export const PAYMENT_STATUSES_ALL: readonly PaymentStatus[] = ["UNPAID", "PENDING_VERIFICATION", "VERIFIED", "PAID", "REJECTED", "REFUNDED"];
export const BOOKING_CODE_PATTERN = /^BK-\d{8}-[A-Z0-9]{4}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

/** What the guest chose: one unit, or own-tent camping with N tents. */
export type StaySelection =
  | { kind: "UNIT"; unitId: string }
  | { kind: "CAMPING"; tents: number };

export interface FoodSelection {
  optionId: string;
  serviceDate: string;
  /** PER_PERSON: number of adults / children eating. */
  adults?: number;
  children?: number;
  /** PER_SET / PER_ITEM / PER_NIGHT: how many. */
  quantity?: number;
}

export interface QuoteRequest {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  stay: StaySelection;
  food: FoodSelection[];
  lang?: string;
}

export interface CreateBookingRequest extends QuoteRequest {
  customer: {
    name: string;
    phone: string;
    email?: string;
    lineId?: string;
    note?: string;
  };
  privacyAccepted: boolean;
  /** The total the guest saw; the server refuses if the price changed meanwhile. */
  expectedTotalSatang: number;
  /** Random client key: retries/double clicks return the same booking. */
  idempotencyKey: string;
}

export interface NightPriceDto {
  date: string;
  priceSatang: number;
}

export interface QuoteItemDto {
  type: BookingItemType;
  unitId: string | null;
  slug: string | null;
  name: string;
  quantity: number;
  pricingType: "PER_UNIT_NIGHT" | "PER_ADULT_NIGHT";
  nightly: NightPriceDto[];
  subtotalSatang: number;
}

export interface IncludedMealDto {
  categoryCode: string;
  name: string;
  personsPerNight: number;
  nights: number;
}

export interface FoodLineDto {
  optionId: string;
  categoryCode: string;
  name: string;
  serviceDate: string;
  pricingType: FoodPricingType;
  adults: number;
  children: number;
  quantity: number;
  includedQuantity: number;
  unitPriceSatang: number;
  subtotalSatang: number;
}

export interface QuoteDto {
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  item: QuoteItemDto;
  includedMeals: IncludedMealDto[];
  food: FoodLineDto[];
  accommodationSubtotalSatang: number;
  foodSubtotalSatang: number;
  discountSatang: number;
  totalSatang: number;
  currency: string;
}

export interface PublicBookingDto extends QuoteDto {
  bookingCode: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  customerName: string;
  /** Only the last 4 digits are shown back (the guest typed the full number). */
  customerPhoneMasked: string;
  expiresAt: string | null;
  createdAt: string;
  /** LINE updates for this booking (Phase 11): offered when the property has it on; linked = guest opted in. */
  lineUpdates: GuestLineDto;
  /** Where and how much to pay — present only while the booking awaits payment. */
  paymentInstructions: PaymentInstructionsDto | null;
}

export interface AdminBookingSummaryDto {
  id: string;
  bookingCode: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  itemType: BookingItemType;
  itemName: string;
  quantity: number;
  customerName: string;
  customerPhone: string;
  totalSatang: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface AdminBookingDto extends PublicBookingDto {
  id: string;
  source: string;
  languageCode: string;
  customerPhone: string;
  customerEmail: string | null;
  customerLineId: string | null;
  customerNote: string | null;
  privacyAcceptedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedAt: string;
  paymentAccount: PaymentAccountSnapshotDto | null;
  payments: PaymentDto[];
}

// ------------------------------------------------------------------ food catalogue for a stay

export interface FoodDateDto {
  date: string;
  /** false when the order deadline has passed. */
  orderable: boolean;
  /** Extra portions still available; null = unlimited. */
  remaining: number | null;
}

export interface FoodOptionDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  allergens: string | null;
  pricingType: FoodPricingType;
  priceSatang: number;
  childPricing: ChildPricing;
  childPriceSatang: number | null;
  personsPerSet: number | null;
  minQuantity: number;
  maxQuantity: number | null;
}

export interface FoodCategoryDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  serviceTime: string | null;
  /** 1 = served the morning after each night (breakfast). */
  serviceDayOffset: 0 | 1;
  dates: FoodDateDto[];
  options: FoodOptionDto[];
}

export interface FoodCatalogueDto {
  checkIn: string;
  checkOut: string;
  categories: FoodCategoryDto[];
}

// ------------------------------------------------------------------ admin pricing rules

export type PricingTargetType = "UNIT" | "UNIT_TYPE" | "CAMPING";

export interface PricingRuleDto {
  id: string;
  targetType: PricingTargetType;
  unitId: string | null;
  unitType: "HOUSE" | "VIP_TENT" | null;
  name: string;
  dateFrom: string;
  dateTo: string;
  /** "0123456" — 0 = Sunday. */
  daysOfWeek: string;
  priceSatang: number;
  priority: number;
  status: "ACTIVE" | "INACTIVE";
  updatedAt: string;
}

export type PricingRuleInput = Omit<PricingRuleDto, "id" | "updatedAt">;

/** Last 4 digits only: "•••• 5678". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `•••• ${digits.slice(-4)}`;
}

/**
 * Canonical phone for matching (lookup): digits only, a leading "+" kept;
 * Thai +66 numbers become the domestic 0-prefixed form so either spelling matches.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\+?[0-9 ()-]{6,24}$/.test(trimmed)) return null;
  let digits = (trimmed.startsWith("+") ? "+" : "") + trimmed.replace(/\D/g, "");
  if (digits.startsWith("+66")) digits = `0${digits.slice(3)}`;
  const count = digits.replace("+", "").length;
  if (count < 6 || count > 15) return null;
  return digits;
}
