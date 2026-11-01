import type { StayPromotionDto } from "../../shared/booking-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

/** What one stay of a booking got from a promotion (migration 0055), frozen at booking time. */
export interface BookingPromotionRow {
  booking_item_id: string | null;
  rule_id: string | null;
  promo_text: string | null;
  room_discount_satang: number;
  extra_bed_free_satang: number;
  pets_free_satang: number;
  food_free_satang: number;
}

export class PromotionRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  insertStatement(id: string, bookingId: string, itemId: string, p: StayPromotionDto, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_promotions (id, booking_id, booking_item_id, rule_id, promo_text, room_discount_satang,
           extra_bed_free_satang, pets_free_satang, food_free_satang, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(id, bookingId, itemId, p.ruleId, p.text, p.roomDiscountSatang, p.extraBedFreeSatang, p.petsFreeSatang, p.foodFreeSatang, now);
  }

  /** A booking's promotions; none before migration 0055. */
  forBooking(bookingId: string): Promise<BookingPromotionRow[]> {
    return withFallback(
      async () => (await this.db
        .prepare(
          `SELECT booking_item_id, rule_id, promo_text, room_discount_satang, extra_bed_free_satang, pets_free_satang, food_free_satang
             FROM booking_promotions WHERE booking_id = ?1 ORDER BY created_at, id`,
        )
        .bind(bookingId).all<BookingPromotionRow>()).results,
      async () => [],
    );
  }
}

export function toStayPromotion(r: BookingPromotionRow): StayPromotionDto {
  return {
    ruleId: r.rule_id, text: r.promo_text, roomDiscountSatang: r.room_discount_satang,
    extraBedFreeSatang: r.extra_bed_free_satang, petsFreeSatang: r.pets_free_satang, foodFreeSatang: r.food_free_satang,
  };
}

export const promotionSaving = (p: Pick<StayPromotionDto, "roomDiscountSatang" | "extraBedFreeSatang" | "petsFreeSatang" | "foodFreeSatang">): number =>
  p.roomDiscountSatang + p.extraBedFreeSatang + p.petsFreeSatang + p.foodFreeSatang;
