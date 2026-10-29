import type { MoveDayState } from "../../shared/booking-types.ts";
import { addDays } from "../../shared/dates.ts";

/** How far ahead a stay can be moved. */
export const MOVE_MAX_DAYS_AHEAD = 730;

/** A house / VIP tent of the booking that moves (the room it has now and who stays in it). */
export interface RoomStay {
  itemId: string;
  unitId: string;
  type: "HOUSE" | "VIP_TENT";
  guests: number;
}

/** A room that could take a stay: bookable, its type and size, the nights others hold (this booking's excluded). */
export interface RoomCandidate {
  unitId: string;
  type: "HOUSE" | "VIP_TENT";
  maxGuests: number;
  /** Order among rooms (the site's sort order, then code). */
  rank: number;
  taken: ReadonlySet<string>;
}

export interface MoveInputs {
  /** The booking's current stay. */
  checkIn: string;
  nights: number;
  today: string;
  /** A house / VIP tent: nights held by another booking or blocked (the booking's own nights excluded). */
  unitTaken: ReadonlySet<string> | null;
  /**
   * Its rooms and every room of the same types: when the booked rooms are not free on a new day, another free room
   * of the same type and size may take the stay (Change dates → another room).
   */
  rooms: { stays: RoomStay[]; candidates: RoomCandidate[] } | null;
  /** Own-tent camping: tents needed, and tents free on a date counting this booking's own as free. */
  tents: { need: number; free: (date: string) => number } | null;
  tarps: { need: number; free: (date: string) => number } | null;
  /** The booking's meal orders that hold kitchen capacity: day offset from check-in, and how many. */
  food: { offset: number; categoryId: string; need: number }[];
  foodFree: (categoryId: string, date: string) => number;
}

export const stayDates = (date: string, nights: number): string[] => Array.from({ length: nights }, (_, i) => addDays(date, i));

/** Rooms that could take one stay on these nights: same type, big enough, free every night; its own room first. */
export function roomsFor(stay: RoomStay, candidates: RoomCandidate[], nights: string[]): RoomCandidate[] {
  return candidates
    .filter((c) => c.type === stay.type && c.maxGuests >= stay.guests && nights.every((n) => !c.taken.has(n)))
    .sort((a, b) => Number(b.unitId === stay.unitId) - Number(a.unitId === stay.unitId) || a.maxGuests - b.maxGuests || a.rank - b.rank);
}

/**
 * A free room for every stay of the booking from `date` (same number of nights), each room used once: its own room
 * whenever it is free, otherwise the smallest free room of the same type that fits (bipartite matching, so two stays
 * never fight over one room while another would do). null = no such assignment.
 * `wanted` pins stays to rooms chosen by staff (checked, never changed).
 */
export function assignRooms(
  date: string, nights: number, stays: RoomStay[], candidates: RoomCandidate[], wanted: ReadonlyMap<string, string> = new Map(),
): Map<string, string> | null {
  const days = stayDates(date, nights);
  const options = new Map(stays.map((s) => {
    const free = roomsFor(s, candidates, days);
    const pin = wanted.get(s.itemId);
    return [s.itemId, pin ? free.filter((c) => c.unitId === pin) : free] as const;
  }));
  const owner = new Map<string, string>(); // unitId → itemId
  const place = (itemId: string, seen: Set<string>): boolean => {
    for (const c of options.get(itemId)!) {
      if (seen.has(c.unitId)) continue;
      seen.add(c.unitId);
      const holder = owner.get(c.unitId);
      if (!holder || place(holder, seen)) {
        owner.set(c.unitId, itemId);
        return true;
      }
    }
    return false;
  };
  // Stays that keep their own room first, so a free own room is never handed to another stay.
  const order = [...stays].sort((a, b) => Number(options.get(b.itemId)![0]?.unitId === b.unitId) - Number(options.get(a.itemId)![0]?.unitId === a.unitId));
  for (const s of order) if (!place(s.itemId, new Set())) return null;
  return new Map([...owner].map(([unitId, itemId]) => [itemId, unitId]));
}

/**
 * Whether the stay could start on `date` instead (same number of nights). Pure: the data comes from D1 and
 * the D1 batch of the move re-checks every limit itself (PK / CHECK constraints), so this only paints the
 * calendar and gives a clear reason before trying.
 *   OTHER_UNITS: the booked rooms are not free, but other free rooms of the same type can take every stay.
 */
export function moveDayState(date: string, x: MoveInputs): MoveDayState {
  if (date === x.checkIn) return "CURRENT";
  if (date < x.today) return "PAST";
  if (date > addDays(x.today, MOVE_MAX_DAYS_AHEAD)) return "TOO_FAR";
  const nights = stayDates(date, x.nights);
  let otherRooms = false;
  if (x.unitTaken && nights.some((n) => x.unitTaken!.has(n))) {
    if (!x.rooms || !assignRooms(date, x.nights, x.rooms.stays, x.rooms.candidates)) return "TAKEN";
    otherRooms = true;
  }
  if (x.tents && nights.some((n) => x.tents!.free(n) < x.tents!.need)) return "TAKEN";
  if (x.tarps && nights.some((n) => x.tarps!.free(n) < x.tarps!.need)) return "TARP_FULL";
  if (x.food.some((f) => x.foodFree(f.categoryId, addDays(date, f.offset)) < f.need)) return "FOOD_FULL";
  return otherRooms ? "OTHER_UNITS" : "OK";
}

/**
 * The days nearest to `date` (either side, the later one first on a tie) the stay could start on: free in its own
 * rooms or in others. For when nothing is free on the day staff wanted.
 */
export function nearestDays(date: string, x: MoveInputs, span: number, limit: number): { date: string; state: MoveDayState }[] {
  const out: { date: string; state: MoveDayState }[] = [];
  for (let d = 1; d <= span && out.length < limit; d++) {
    for (const day of [addDays(date, d), addDays(date, -d)]) {
      const state = moveDayState(day, x);
      if ((state === "OK" || state === "OTHER_UNITS") && out.length < limit) out.push({ date: day, state });
    }
  }
  return out;
}
