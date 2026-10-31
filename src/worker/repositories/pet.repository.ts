import type { PetChargePer } from "../../shared/booking-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

/** Pets settings (migration 0044): one row. */
export interface PetSettingsRow {
  is_enabled: number;
  price_satang: number;
  charge_per: PetChargePer;
  max_weight_kg: number;
  max_per_unit: number;
  updated_at: string | null;
}

/** Pets of one stay of a booking (price snapshot). */
export interface BookingPetRow {
  booking_item_id: string;
  quantity: number;
  price_satang: number;
  charge_per: PetChargePer;
  charged_units: number;
  max_weight_kg: number;
  subtotal_satang: number;
}

/** Before migration 0044: the option does not exist (off). */
const OFF: PetSettingsRow = { is_enabled: 0, price_satang: 0, charge_per: "NIGHT", max_weight_kg: 10, max_per_unit: 2, updated_at: null };

export class PetRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  settings(): Promise<PetSettingsRow> {
    return withFallback(
      async () => (await this.db
        .prepare("SELECT is_enabled, price_satang, charge_per, max_weight_kg, max_per_unit, updated_at FROM pet_settings WHERE id = 1")
        .first<PetSettingsRow>()) ?? OFF,
      async () => OFF,
    );
  }

  saveStatement(s: {
    enabled: boolean; priceSatang: number; chargePer: PetChargePer; maxWeightKg: number; maxPerUnit: number; userId: string; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO pet_settings (id, is_enabled, price_satang, charge_per, max_weight_kg, max_per_unit, updated_by, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET is_enabled = excluded.is_enabled, price_satang = excluded.price_satang,
           charge_per = excluded.charge_per, max_weight_kg = excluded.max_weight_kg, max_per_unit = excluded.max_per_unit,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(s.enabled ? 1 : 0, s.priceSatang, s.chargePer, s.maxWeightKg, s.maxPerUnit, s.userId, s.now);
  }

  /** Pets of a booking, per stay (none before migration 0044). */
  forBooking(bookingId: string): Promise<BookingPetRow[]> {
    return withFallback(
      async () => (await this.db
        .prepare(
          `SELECT booking_item_id, quantity, price_satang, charge_per, charged_units, max_weight_kg, subtotal_satang
             FROM booking_pets WHERE booking_id = ?1`,
        )
        .bind(bookingId)
        .all<BookingPetRow>()).results,
      async () => [],
    );
  }

  /** Price snapshot (immutable; the trigger checks the stay is a house / VIP tent and the option is on). */
  insertStatement(p: {
    id: string; bookingId: string; itemId: string; quantity: number; priceSatang: number; chargePer: PetChargePer;
    chargedUnits: number; maxWeightKg: number; subtotal: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_pets (id, booking_id, booking_item_id, quantity, price_satang, charge_per, charged_units, max_weight_kg, subtotal_satang, captured_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(p.id, p.bookingId, p.itemId, p.quantity, p.priceSatang, p.chargePer, p.chargedUnits, p.maxWeightKg, p.subtotal, p.now);
  }
}
