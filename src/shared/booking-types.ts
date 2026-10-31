/**
 * Booking API contract shared by the Worker and the React app.
 * Money is always integer satang. Dates are YYYY-MM-DD business dates (Asia/Bangkok).
 */

import type { StayActionsDto } from "./stay.ts";
import type { GuestLineDto } from "./line-types.ts";
import type { BalancePaymentDto, PaymentAccountSnapshotDto, PaymentDto, PaymentInstructionsDto } from "./payment-types.ts";
import type { AppFeeDto } from "./credit-types.ts";

export type BookingItemType = "HOUSE" | "VIP_TENT" | "OWN_TENT";
export type BookingStatus = "PENDING" | "CONFIRMED" | "CHECKED_IN" | "CHECKED_OUT" | "CANCELLED" | "EXPIRED" | "NO_SHOW";
export type PaymentStatus = "UNPAID" | "PENDING_VERIFICATION" | "VERIFIED" | "PAID" | "REJECTED" | "REFUNDED";
export type FoodPricingType = "PER_PERSON" | "PER_SET" | "PER_ITEM" | "PER_NIGHT";
export type ChildPricing = "FREE" | "FULL" | "HALF" | "SPECIAL_PRICE";

export const PAYMENT_STATUSES_ALL: readonly PaymentStatus[] = ["UNPAID", "PENDING_VERIFICATION", "VERIFIED", "PAID", "REJECTED", "REFUNDED"];
export const BOOKING_CODE_PATTERN = /^BK-\d{8}-[A-Z0-9]{4}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

/**
 * One stay the guest chose: a house / VIP tent, or own-tent camping with N tents (and optionally one tarp area).
 * In `stays` (several stays in one booking) each stay carries its own guests; a single legacy `stay` takes the
 * booking's adults / children.
 */
export type StaySelection =
  | { kind: "UNIT"; unitId: string; adults?: number; children?: number; extraBeds?: number; pets?: number }
  | { kind: "CAMPING"; tents: number; tarp?: boolean; adults?: number; children?: number };

/** Most extra beds one house / VIP tent can ever take (the owner's limit is at most this). */
export const MAX_EXTRA_BEDS_PER_UNIT = 10;

/** Most stays one booking can hold (houses / VIP tents + camping). */
export const MAX_STAYS_PER_BOOKING = 10;

export interface FoodSelection {
  optionId: string;
  serviceDate: string;
  /** PER_PERSON: number of adults / children eating. */
  adults?: number;
  children?: number;
  /** PER_SET / PER_ITEM / PER_NIGHT: how many. */
  quantity?: number;
}

/** Health massage (migration 0050): one treatment length the guest picked, for how many people. */
export interface MassageSelection {
  optionId: string;
  quantity: number;
}

/** Most people per massage line / most lines per booking. */
export const MAX_MASSAGE_QUANTITY = 20;
export const MAX_MASSAGE_LINES = 30;
/** Most treatments on the owner's menu. */
export const MAX_MASSAGE_ITEMS = 40;

export interface MassageOptionDto {
  id: string;
  minutes: number;
  priceSatang: number;
}

/** A treatment as the booking page shows it (name in the page's language). */
export interface MassageItemDto {
  id: string;
  name: string;
  /** The Thai / English name under it when the page shows another language. */
  subName: string | null;
  options: MassageOptionDto[];
}

/** One massage line of a quote / booking (snapshot once booked). */
export interface MassageLineDto {
  optionId: string;
  name: string;
  minutes: number;
  priceSatang: number;
  quantity: number;
  subtotalSatang: number;
}

/** Admin → massage menu (migration 0050). */
export interface MassageAdminItemDto {
  id: string;
  nameTh: string;
  nameEn: string | null;
  nameZh: string | null;
  active: boolean;
  options: MassageOptionDto[];
}

export interface MassageSettingsDto {
  enabled: boolean;
  items: MassageAdminItemDto[];
  updatedAt: string | null;
}

export interface QuoteRequest {
  checkIn: string;
  checkOut: string;
  /** All guests of the booking (with `stays`: the sum of the stays' guests). */
  adults: number;
  children: number;
  /** One stay (older pages). */
  stay?: StaySelection;
  /** Several stays on the same dates, each with its own guests (same check-in / check-out for all). */
  stays?: StaySelection[];
  food: FoodSelection[];
  /** Health massage (migration 0050), paid in full at booking like food. */
  massages?: MassageSelection[];
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
  /** Guests of this stay. */
  adults: number;
  children: number;
  /** Deposit plan: the part of this stay (with its tarp area) left for check-in; 0 = paid in full now. */
  payLaterSatang: number;
  /** Extra beds of this house / VIP tent (migration 0043); part of the stay's money and of its deposit. */
  extraBeds?: ExtraBedLineDto | null;
  /** Pets brought to this house / VIP tent (migration 0044); part of the stay's money and of its deposit. */
  pets?: PetLineDto | null;
  /** A booking's stay (not in a quote): its id, and whether staff cancelled it. */
  id?: string;
  status?: "ACTIVE" | "CANCELLED";
  /** Why staff cancelled this stay alone. */
  cancelReason?: string | null;
}

/** Camping add-on: extra space for a tarp next to the tents, priced per area per night (one per booking). */
export interface TarpLineDto {
  quantity: number;
  pricePerNightSatang: number;
  nights: number;
  subtotalSatang: number;
}

/** Extra beds (ที่นอนเสริม) of one house / VIP tent: beds × price per bed per night × nights. */
export type ExtraBedLineDto = TarpLineDto;

/** What the booking page offers (null / absent = no extra beds). */
export interface ExtraBedOfferDto {
  pricePerNightSatang: number;
  maxPerUnit: number;
  /** Houses / VIP tents that do not take extra beds (switched off one by one; migration 0047). */
  offUnitIds?: string[];
}

/** Pet fee: per pet per night, or per pet per stay. */
export type PetChargePer = "NIGHT" | "STAY";
export const PET_CHARGE_PER: readonly PetChargePer[] = ["NIGHT", "STAY"];
export const MAX_PETS_PER_UNIT = 10;
export const MAX_PET_WEIGHT_KG = 200;

/** Pets of one house / VIP tent: pets × price × (nights, or 1 per stay); each no heavier than maxWeightKg. */
export interface PetLineDto {
  quantity: number;
  priceSatang: number;
  chargePer: PetChargePer;
  /** Nights (per night) or 1 (per stay). */
  chargedUnits: number;
  maxWeightKg: number;
  subtotalSatang: number;
}

/** What the booking page offers for pets (null / absent = no pets). */
export interface PetOfferDto {
  priceSatang: number;
  chargePer: PetChargePer;
  maxWeightKg: number;
  maxPerUnit: number;
}

/** Admin → pets settings (migration 0044). */
export interface PetSettingsDto {
  enabled: boolean;
  priceSatang: number;
  chargePer: PetChargePer;
  maxWeightKg: number;
  maxPerUnit: number;
  updatedAt: string | null;
}

/** Admin → extra beds settings (migration 0043). */
export interface ExtraBedSettingsDto {
  enabled: boolean;
  pricePerNightSatang: number;
  maxPerUnit: number;
  /** Houses / VIP tents where extra beds are switched off (empty = all take them while on; migration 0047). */
  offUnitIds: string[];
  updatedAt: string | null;
}

export interface IncludedMealDto {
  categoryCode: string;
  name: string;
  personsPerNight: number;
  nights: number;
  /** The stay it comes with (several stays in the booking); null with one stay. */
  stayName?: string | null;
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
  /** The stays, in the order chosen (a booking also lists the stays staff cancelled, with status CANCELLED). */
  items: QuoteItemDto[];
  /** The first stay — kept for pages built before several stays per booking. */
  item: QuoteItemDto;
  /** Tarp area (camping only); its price is part of accommodationSubtotalSatang. */
  tarp: TarpLineDto | null;
  includedMeals: IncludedMealDto[];
  food: FoodLineDto[];
  /** Health massage lines (migration 0050); absent = none. Paid in full now, part of totalSatang. */
  massages?: MassageLineDto[];
  massageSubtotalSatang?: number;
  accommodationSubtotalSatang: number;
  foodSubtotalSatang: number;
  discountSatang: number;
  totalSatang: number;
  currency: string;
  /**
   * Deposit plan (the house / tent / camping asks for half of the stay now): the amount paid online to confirm.
   * The rest (totalSatang − depositSatang) is paid at reception before check-in. null = pay the full total now.
   */
  depositSatang: number | null;
  /**
   * App-usage fee (migration 0027): units (houses + VIP tents + own tents) × fee per unit, already part of
   * totalSatang. null / absent = no fee (the credit system is off, or a booking made before it).
   */
  appFee?: AppFeeDto | null;
  /**
   * Quote only: the property cannot take this booking online right now (not enough app-usage credit for its
   * units). The guest sees "online booking unavailable — contact us"; creating it answers 409 CREDIT_INSUFFICIENT.
   */
  bookingUnavailable?: boolean;
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
  /** Money received (verified / paid payments, before refunds). */
  paidSatang: number;
  /** Still to pay: total − paid. For a confirmed deposit booking, the amount due at check-in. */
  balanceSatang: number;
  /** Where and how much to pay — present only while the booking awaits payment. */
  paymentInstructions: PaymentInstructionsDto | null;
  /** Deposit plan, confirmed booking still owing money: the guest may transfer the rest before the stay. */
  balancePayment: BalancePaymentDto | null;
  /** Why the last payment was not accepted (shown while the guest can pay again). */
  paymentRejectedReason: string | null;
  /** Why staff cancelled the booking. */
  cancelReason: string | null;
  /** Moves the guest paid for (migration 0045): fee + higher price, part of the accommodation total. */
  moveCharges?: { toCheckIn: string; feeSatang: number; diffSatang: number }[];
}

/** A stay in admin lists: what it is and, for camping, how many tents. */
export interface BookingStayBriefDto {
  type: BookingItemType;
  name: string;
  quantity: number;
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
  /** First stay (type / quantity); itemName names every stay ("House 01 + VIP 02 + Camping"). */
  itemType: BookingItemType;
  itemName: string;
  quantity: number;
  /** Every active stay of the booking. */
  stays: BookingStayBriefDto[];
  /** Tarp areas booked with own-tent camping (0 = none). */
  tarps: number;
  customerName: string;
  customerPhone: string;
  totalSatang: number;
  /** Deposit plan: amount asked online; null = full payment. */
  depositSatang: number | null;
  /** Still to pay (total − verified / paid payments). */
  balanceSatang: number;
  expiresAt: string | null;
  createdAt: string;
  /** Check-in / check-out / no-show today (see shared/stay.ts). */
  stayActions: StayActionsDto;
}

/**
 * Admin → booking → Change dates: which new check-in days work for this stay (same number of nights).
 *   OK         every night is free (and the tents / tarp / food capacity fits)
 *   CURRENT    the booking's own check-in day
 *   TAKEN      a night is booked or blocked, or camping is full
 *   TARP_FULL  no tarp area left on a night (camping add-on)
 *   FOOD_FULL  a meal of the booking is sold out on its new day
 *   OTHER_UNITS the booked house / VIP tent is not free, but other free rooms of the same type can take the stay
 *   PAST       before today · TOO_FAR more than two years ahead
 */
export type MoveDayState = "OK" | "OTHER_UNITS" | "CURRENT" | "TAKEN" | "TARP_FULL" | "FOOD_FULL" | "PAST" | "TOO_FAR";

export interface BookingMoveOptionsDto {
  checkIn: string;
  checkOut: string;
  nights: number;
  /** Today in the property time zone. */
  today: string;
  days: { date: string; state: MoveDayState }[];
}

/**
 * Admin → booking → Change dates → a day: the room each house / VIP-tent stay would have, the free rooms to choose
 * from, and — when the stay does not fit that day — the nearest days it does.
 */
export interface BookingMoveRoomsDto {
  checkIn: string;
  checkOut: string;
  state: MoveDayState;
  stays: {
    itemId: string;
    type: "HOUSE" | "VIP_TENT";
    /** The room it has now. */
    unitId: string;
    name: string;
    guests: number;
    /** What the booking was sold at for this stay (kept when the room changes). */
    bookedSatang: number;
    /** The room the system suggests on that day (its own when free); null = none free. */
    suggested: string | null;
    /** Rooms of the same type that fit the guests: free on every night or not; own room first. */
    options: { unitId: string; code: string; name: string; maxGuests: number; free: boolean; own: boolean; priceSatang: number }[];
  }[];
  /** Nearest days the stay fits (own rooms or others), nearest first. */
  nearest: { checkIn: string; checkOut: string; state: MoveDayState }[];
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
  /** Check-in / check-out / no-show today (see shared/stay.ts). */
  stayActions: StayActionsDto;
  /** Moves the guest asked for (migration 0045), newest first. */
  moveRequests?: MoveRequestDto[];
  /**
   * Booked with a deposit, but the house / camping now takes full payment: this booking keeps the deposit plan
   * agreed at booking time (the rest is still taken at check-in).
   */
  depositPlanKept: boolean;
  /** Money received beyond the total (a stay was cancelled after payment): to refund to the guest. */
  overpaidSatang: number;
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
  /** Dish photo (Phase 12). */
  image: { url: string; srcset: string | null; alt: string; width: number | null; height: number | null } | null;
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

/** GET /api/public/food-menu — active dishes by category, no dates (home "food preview", Phase 12). */
export interface FoodMenuDto {
  categories: { id: string; code: string; name: string; description: string | null; serviceTime: string | null; options: FoodOptionDto[] }[];
}

export interface FoodCatalogueDto {
  checkIn: string;
  checkOut: string;
  categories: FoodCategoryDto[];
  /** Extra beds for houses / VIP tents, when the owner offers them (shown on the same step). */
  extraBed?: ExtraBedOfferDto | null;
  /** Health massage menu (migration 0050); null / absent = not offered. */
  massage?: { items: MassageItemDto[] } | null;
  /** Pets allowed in houses / VIP tents, when the owner allows them. */
  pet?: PetOfferDto | null;
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
  /** Pay online at booking for the nights this rule prices: 10–100 %; null = the stay's own plan (migration 0049). */
  payNowPercent: number | null;
  updatedAt: string;
}

export type PricingRuleInput = Omit<PricingRuleDto, "id" | "updatedAt">;

/** Last 4 digits only: "•••• 5678". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `•••• ${digits.slice(-4)}`;
}

/**
 * Half of the digits hidden, in the middle: "081-234-5678" → "081*****78", "+66812345678" → "+668******78".
 * For staff notices (LINE / e-mail): enough to recognise a guest, not to call or copy the number.
 */
export function maskPhoneHalf(phone: string): string {
  const plus = phone.trim().startsWith("+") ? "+" : "";
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  const hidden = Math.ceil(digits.length / 2);
  const shown = digits.length - hidden;
  const head = Math.ceil(shown / 2);
  return `${plus}${digits.slice(0, head)}${"*".repeat(hidden)}${digits.slice(head + hidden)}`;
}

/** The second half of the name before "@" hidden, the domain kept: "somchai@gmail.com" → "som****@gmail.com". */
export function maskEmailHalf(email: string): string {
  const value = email.trim();
  const at = value.lastIndexOf("@");
  const local = at > 0 ? value.slice(0, at) : value;
  const domain = at > 0 ? value.slice(at) : "";
  const chars = Array.from(local);
  const hidden = Math.ceil(chars.length / 2);
  return `${chars.slice(0, chars.length - hidden).join("")}${"*".repeat(hidden)}${domain}`;
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

// ------------------------------------------------------------------ guest moves the stay (migration 0045)

export type MoveRequestStatus = "AWAITING_PAYMENT" | "REVIEWING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "FAILED";

/** Admin → move settings: on / off, fee, how close to the check-in, how many moves, how long the new nights are held. */
export interface MoveSettingsDto {
  enabled: boolean;
  feeSatang: number;
  minDaysBefore: number;
  maxMoves: number;
  payMinutes: number;
  updatedAt: string | null;
}

/** One house / VIP tent of a move: its room before and after (the same room when it did not change). */
export interface MoveRoomDto {
  itemId: string;
  fromUnitId: string;
  fromName: string;
  toUnitId: string;
  toName: string;
}

export interface MoveRequestDto {
  id: string;
  status: MoveRequestStatus;
  fromCheckIn: string;
  fromCheckOut: string;
  toCheckIn: string;
  toCheckOut: string;
  rooms: MoveRoomDto[];
  feeSatang: number;
  /** Higher price of the new nights (0 when the same or cheaper). */
  diffSatang: number;
  amountSatang: number;
  /** AWAITING_PAYMENT: transfer and send the slip before this time (the new nights are held until then). */
  expiresAt: string;
  /** Why staff turned the slip down / why it failed. */
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Booking page → "เลื่อนวันเข้าพัก": what the guest may do with this booking. */
export interface GuestMoveStartDto {
  bookingCode: string;
  customerName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  /** The houses / VIP tents of the booking. */
  stays: { itemId: string; name: string }[];
  feeSatang: number;
  minDaysBefore: number;
  /** Moves still allowed. */
  movesLeft: number;
  /** Earliest new check-in the guest may pick. */
  earliest: string;
  /** null = may move; otherwise why not (MOVE_NOT_OFFERED, MOVE_NOT_CONFIRMED, MOVE_TOO_LATE, MOVE_LIMIT, MOVE_CAMPING). */
  blocked: string | null;
  /** The open request (waiting for the transfer / being checked), or the last one that ended. */
  request: GuestMoveRequestDto | null;
}

export interface GuestMoveRequestDto extends MoveRequestDto {
  /** While AWAITING_PAYMENT: where and how much to transfer. */
  paymentInstructions: PaymentInstructionsDto | null;
}
