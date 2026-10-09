/**
 * Check-in / check-out / no-show: which of them staff can press today (property time zone). The Worker
 * enforces exactly these rules (BookingService.adminStay); the admin uses them to show the right buttons.
 *
 *   check-in   CONFIRMED, from the check-in date until the night before check-out
 *   no-show    CONFIRMED, from the check-in date
 *   check-out  CHECKED_IN, any day (early departures too)
 */

/** OK = can be done today; NOT_YET = before the check-in date; ENDED = the stay is already over. */
export type StayGate = "OK" | "NOT_YET" | "ENDED";

/** null = not possible in the booking's current status. */
export interface StayActionsDto {
  checkIn: StayGate | null;
  checkOut: StayGate | null;
  noShow: StayGate | null;
}

export function stayActions(status: string, checkIn: string, checkOut: string, today: string): StayActionsDto {
  const confirmed = status === "CONFIRMED";
  return {
    checkIn: confirmed ? (today < checkIn ? "NOT_YET" : today >= checkOut ? "ENDED" : "OK") : null,
    noShow: confirmed ? (today < checkIn ? "NOT_YET" : "OK") : null,
    checkOut: status === "CHECKED_IN" ? "OK" : null,
  };
}
