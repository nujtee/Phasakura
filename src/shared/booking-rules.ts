/**
 * Stay-window rules shared by the Worker (enforcement) and the UI (date pickers).
 * These are business configuration; they move to admin settings in Phase 9.
 */
export const STAY_RULES = {
  maxNights: 30,
  /** How far ahead a stay may start (days from today). */
  maxAdvanceDays: 365,
  /** Admin availability grid window. */
  maxGridDays: 62,
} as const;

/** Money is integer satang in the API and DB (1 THB = 100 satang). */
export const SATANG_PER_BAHT = 100;
export const MAX_PRICE_SATANG = 100_000_000; // 1,000,000 THB

/** ฿3,500 for whole baht, ฿2,450.50 otherwise (never "2,450.5"). */
export function formatBaht(satang: number, locale: string): string {
  const digits = satang % SATANG_PER_BAHT === 0 ? 0 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency", currency: "THB", currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits,
  })
    .format(satang / SATANG_PER_BAHT);
}

/** "1,234.50" / "1234.5" → 123450 satang; null if not a valid non-negative amount with ≤ 2 decimals. */
export function parseBahtToSatang(input: string): number | null {
  const clean = input.replace(/[,\s฿]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  return Number(whole) * SATANG_PER_BAHT + Number(frac.padEnd(2, "0"));
}

/**
 * How a stay is paid: all now, or a deposit of 50 / 60 / 70 % of the stay now and the rest at reception before
 * check-in (migrations 0025, 0054). Stored as payment_mode FULL / DEPOSIT_50 (= a deposit plan) + deposit_percent.
 */
export const PAYMENT_MODES = ["FULL", "DEPOSIT_50", "DEPOSIT_60", "DEPOSIT_70"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Share of the stay paid when booking: FULL = 100, DEPOSIT_60 = 60 … */
export function payNowPercentOf(mode: PaymentMode): number {
  return mode === "FULL" ? 100 : Number(mode.slice("DEPOSIT_".length));
}

/** What D1 keeps (migration 0054): payment_mode FULL / DEPOSIT_50, and deposit_percent 60 / 70 (NULL = 50 %). */
export function storedPaymentMode(mode: PaymentMode): "FULL" | "DEPOSIT_50" {
  return mode === "FULL" ? "FULL" : "DEPOSIT_50";
}
export function storedDepositPercent(mode: PaymentMode): number | null {
  return mode === "DEPOSIT_60" || mode === "DEPOSIT_70" ? payNowPercentOf(mode) : null;
}

/**
 * Amount asked online to confirm a deposit booking: everything except the part of the stay (accommodation + tarp
 * area) left for check-in. That part is rounded down to whole baht, so the deposit is never less than its
 * percentage; food is paid in full now. null = nothing would be left for later (pay the full total).
 */
export function depositDue(mode: PaymentMode, accommodationSubtotalSatang: number, totalSatang: number): number | null {
  return depositFor(totalSatang, payLaterOf(mode, accommodationSubtotalSatang));
}

/** The part of one stay (accommodation + its tarp area) left for check-in: (100 − deposit) % of it, whole baht down. */
export function payLaterOf(mode: PaymentMode, staySubtotalSatang: number): number {
  if (mode === "FULL") return 0;
  const later = (staySubtotalSatang * (100 - payNowPercentOf(mode))) / 100;
  return Math.floor(later / SATANG_PER_BAHT) * SATANG_PER_BAHT;
}

/** Pay-now percentages a price rule may set (migration 0049); null on a rule = the stay's own plan. */
export const PAY_NOW_PERCENTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/**
 * The part of one stay left for check-in when price rules set their own pay-now percentage (migration 0049).
 * Each night is paid online at the percentage of the rule that priced it (nights without one: the stay's plan,
 * FULL = 100 %, a deposit its percentage). `factor` multiplies every night (adults for camping); `extrasSatang` (extra beds,
 * pets, tarp area) is split at the same share as the nights. Whole baht down, like payLaterOf. Without any rule
 * percentage it is exactly payLaterOf.
 */
export function payLaterOfNights(
  mode: PaymentMode, nights: { priceSatang: number; payNowPercent?: number | null }[], factor: number, extrasSatang: number,
): number {
  const room = nights.reduce((acc, n) => acc + n.priceSatang * factor, 0);
  if (nights.every((n) => n.payNowPercent == null)) return payLaterOf(mode, room + extrasSatang);
  const plan = payNowPercentOf(mode);
  const laterRoom = nights.reduce((acc, n) => acc + (n.priceSatang * factor * (100 - (n.payNowPercent ?? plan))) / 100, 0);
  const share = room > 0 ? laterRoom / room : (100 - plan) / 100;
  const later = laterRoom + extrasSatang * share;
  return Math.max(0, Math.floor(later / SATANG_PER_BAHT) * SATANG_PER_BAHT);
}

/** Amount asked online for a booking whose stays leave `laterSatang` for check-in; null = pay the full total now. */
export function depositFor(totalSatang: number, laterSatang: number): number | null {
  const later = Math.min(laterSatang, totalSatang);
  const now = totalSatang - later;
  return later > 0 && now > 0 ? now : null;
}

/** What a booking still owes: the total minus money received (verified / paid payments, never below zero). */
export function balanceDue(totalSatang: number, paidSatang: number): number {
  return Math.max(0, totalSatang - paidSatang);
}
