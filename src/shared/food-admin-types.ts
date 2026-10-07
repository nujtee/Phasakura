/** Kitchen orders (spec §24) and daily food capacity (spec §22) — admin API contract. */
import type { BookingStatus, PaymentStatus } from "./booking-types.ts";
import type { LocaleCode } from "./i18n/locales.ts";

export const FOOD_ORDER_STATUSES = ["PENDING", "CONFIRMED", "PREPARING", "READY", "SERVED", "CANCELLED"] as const;
export type FoodOrderStatus = (typeof FOOD_ORDER_STATUSES)[number];
/** Staff move orders forward only; CANCELLED happens when the booking is cancelled or expires. */
export const FOOD_ORDER_FLOW: readonly FoodOrderStatus[] = ["PENDING", "CONFIRMED", "PREPARING", "READY", "SERVED"];

export interface FoodCategoryRefDto {
  id: string;
  code: string;
  names: Partial<Record<LocaleCode, string>>;
  defaultDailyCapacity: number | null;
  serviceTime: string | null;
  status: string;
}

export interface FoodOrderDto {
  id: string;
  bookingCode: string;
  bookingStatus: BookingStatus;
  paymentStatus: PaymentStatus;
  /** null without `bookings.view`. */
  customerName: string | null;
  itemName: string | null;
  categoryId: string;
  categoryCode: string;
  serviceDate: string;
  serviceTime: string | null;
  status: FoodOrderStatus;
  totalPersons: number;
  kitchenNote: string | null;
  updatedAt: string;
  lines: { name: string; quantity: number; includedQuantity: number; adults: number; children: number; pricingType: string; cancelled: boolean }[];
}

export interface FoodCapacityDto {
  from: string;
  to: string;
  dates: string[];
  categories: FoodCategoryRefDto[];
  /** Per category × date. `max` null = unlimited category. */
  cells: { categoryId: string; date: string; max: number | null; used: number; overridden: boolean }[];
}
