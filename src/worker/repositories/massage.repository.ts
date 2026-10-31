import type { MassageAdminItemDto, MassageLineDto } from "../../shared/booking-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

/** Health massage (migration 0050): settings, the owner's menu, and what each booking took. */
export interface MassageMenuRow {
  item_id: string;
  name_th: string;
  name_en: string | null;
  name_zh: string | null;
  sort_order: number;
  is_active: number;
  option_id: string | null;
  minutes: number | null;
  price_satang: number | null;
}

export interface BookingMassageRow {
  option_id: string;
  name: string;
  minutes: number;
  price_satang: number;
  quantity: number;
  subtotal_satang: number;
}

export class MassageRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** On / off and when it last changed (off before migration 0050). */
  settings(): Promise<{ is_enabled: number; updated_at: string | null }> {
    const off = { is_enabled: 0, updated_at: null };
    return withFallback(
      async () => (await this.db.prepare("SELECT is_enabled, updated_at FROM massage_settings WHERE id = 1")
        .first<{ is_enabled: number; updated_at: string | null }>()) ?? off,
      async () => off,
    );
  }

  /** The whole menu, treatments in order with their lengths (shortest first). */
  async menu(): Promise<MassageAdminItemDto[]> {
    const rows = await withFallback(
      async () => (await this.db
        .prepare(
          `SELECT i.id AS item_id, i.name_th, i.name_en, i.name_zh, i.sort_order, i.is_active, o.id AS option_id, o.minutes, o.price_satang
             FROM massage_items i LEFT JOIN massage_options o ON o.item_id = i.id
            ORDER BY i.sort_order, i.id, o.minutes`,
        )
        .all<MassageMenuRow>()).results,
      async () => [] as MassageMenuRow[],
    );
    const items = new Map<string, MassageAdminItemDto>();
    for (const r of rows) {
      const item = items.get(r.item_id) ?? {
        id: r.item_id, nameTh: r.name_th, nameEn: r.name_en, nameZh: r.name_zh, active: r.is_active === 1, options: [],
      };
      if (r.option_id && r.minutes !== null && r.price_satang !== null) item.options.push({ id: r.option_id, minutes: r.minutes, priceSatang: r.price_satang });
      items.set(r.item_id, item);
    }
    return [...items.values()];
  }

  /** Replaces the settings and the menu in one batch (ids kept, so carts still open stay valid). */
  saveStatements(enabled: boolean, items: MassageAdminItemDto[], userId: string, now: string): D1PreparedStatementLike[] {
    const statements: D1PreparedStatementLike[] = [
      this.db.prepare(
        `INSERT INTO massage_settings (id, is_enabled, updated_by, updated_at) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET is_enabled = excluded.is_enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(enabled ? 1 : 0, userId, now),
      this.db.prepare("DELETE FROM massage_options"),
      this.db.prepare("DELETE FROM massage_items"),
    ];
    items.forEach((item, i) => {
      statements.push(this.db
        .prepare("INSERT INTO massage_items (id, name_th, name_en, name_zh, sort_order, is_active, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(item.id, item.nameTh, item.nameEn, item.nameZh, i + 1, item.active ? 1 : 0, now));
      for (const o of item.options) {
        statements.push(this.db
          .prepare("INSERT INTO massage_options (id, item_id, minutes, price_satang) VALUES (?1, ?2, ?3, ?4)")
          .bind(o.id, item.id, o.minutes, o.priceSatang));
      }
    });
    return statements;
  }

  /** Massages of a booking (none before migration 0050). */
  forBooking(bookingId: string): Promise<BookingMassageRow[]> {
    return withFallback(
      async () => (await this.db
        .prepare("SELECT option_id, name, minutes, price_satang, quantity, subtotal_satang FROM booking_massages WHERE booking_id = ?1 ORDER BY rowid")
        .bind(bookingId)
        .all<BookingMassageRow>()).results,
      async () => [],
    );
  }

  /** Snapshot of one line (the trigger re-checks massage is on and the treatment is on the menu). */
  insertStatement(id: string, bookingId: string, line: MassageLineDto, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_massages (id, booking_id, option_id, name, minutes, price_satang, quantity, subtotal_satang, captured_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(id, bookingId, line.optionId, line.name, line.minutes, line.priceSatang, line.quantity, line.subtotalSatang, now);
  }
}

export function toMassageLine(r: BookingMassageRow): MassageLineDto {
  return { optionId: r.option_id, name: r.name, minutes: r.minutes, priceSatang: r.price_satang, quantity: r.quantity, subtotalSatang: r.subtotal_satang };
}

/** The treatment's name in a language (TH when that language has none). */
export function massageName(item: MassageAdminItemDto, lang: string): string {
  if (lang === "en") return item.nameEn || item.nameTh;
  if (lang === "zh-CN") return item.nameZh || item.nameEn || item.nameTh;
  return item.nameTh;
}
