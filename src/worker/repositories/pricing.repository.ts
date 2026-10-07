import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface PricingRuleRow {
  id: string;
  target_type: "UNIT" | "UNIT_TYPE" | "CAMPING";
  unit_id: string | null;
  unit_type: "HOUSE" | "VIP_TENT" | null;
  name: string;
  date_from: string;
  date_to: string;
  days_of_week: string;
  price_satang: number;
  priority: number;
  status: "ACTIVE" | "INACTIVE";
  created_at: string;
  updated_at: string;
}

export interface FoodCategoryRow {
  id: string;
  code: string;
  default_daily_capacity: number | null;
  deadline_type: "NONE" | "DAYS_BEFORE" | "PREVIOUS_DAY_TIME";
  deadline_days_before: number | null;
  deadline_time: string | null;
  service_time: string | null;
  service_day_offset: 0 | 1;
  sort_order: number;
  status: "ACTIVE" | "INACTIVE";
}

export interface FoodOptionRow {
  id: string;
  food_category_id: string;
  code: string;
  pricing_type: "PER_PERSON" | "PER_SET" | "PER_ITEM" | "PER_NIGHT";
  price_satang: number;
  child_pricing: "FREE" | "FULL" | "HALF" | "SPECIAL_PRICE";
  child_price_satang: number | null;
  persons_per_set: number | null;
  min_quantity: number;
  max_quantity: number | null;
  status: string;
  sort_order: number;
  /** Dish photo (Phase 12): ACTIVE public asset only. */
  image_asset_id?: string | null;
  image_key?: string | null;
  image_width?: number | null;
  image_height?: number | null;
}

export interface NamedTranslationRow {
  id: string;
  language_code: string;
  name: string;
  description: string | null;
  allergens?: string | null;
}

export interface IncludedMealRow {
  id: string;
  target_type: "UNIT" | "UNIT_TYPE" | "CAMPING";
  food_category_id: string;
  food_option_id: string | null;
  persons_per_night: number;
}

export interface FoodCapacityRow {
  food_category_id: string;
  service_date: string;
  max_quantity: number;
  used_quantity: number;
}

export interface BookingSettingsRow {
  hold_minutes: number;
  max_nights: number;
  max_advance_days: number;
  max_tents_per_booking: number;
}

const RULE_COLUMNS = `id, target_type, unit_id, unit_type, name, date_from, date_to, days_of_week, price_satang, priority,
  status, created_at, updated_at`;

/** Read side of pricing, food menu and booking configuration. Source of truth: D1. */
export class PricingRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Active rules overlapping [from, toInclusive] for a unit (UNIT + UNIT_TYPE) or for camping. */
  async activeRules(target: { unitId: string; unitType: string } | "CAMPING", from: string, toInclusive: string): Promise<PricingRuleRow[]> {
    const unitId = target === "CAMPING" ? null : target.unitId;
    const unitType = target === "CAMPING" ? null : target.unitType;
    const { results } = await this.db
      .prepare(
        `SELECT ${RULE_COLUMNS} FROM pricing_settings
          WHERE status = 'ACTIVE' AND date_from <= ?1 AND date_to >= ?2
            AND ((?3 IS NULL AND target_type = 'CAMPING')
              OR (?3 IS NOT NULL AND ((target_type = 'UNIT' AND unit_id = ?3) OR (target_type = 'UNIT_TYPE' AND unit_type = ?4))))`,
      )
      .bind(toInclusive, from, unitId, unitType)
      .all<PricingRuleRow>();
    return results;
  }

  async listRules(filter: { targetType?: string; unitId?: string; status?: string }): Promise<PricingRuleRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${RULE_COLUMNS} FROM pricing_settings
          WHERE (?1 IS NULL OR target_type = ?1) AND (?2 IS NULL OR unit_id = ?2) AND (?3 IS NULL OR status = ?3)
          ORDER BY status, date_from DESC, priority DESC LIMIT 500`,
      )
      .bind(filter.targetType ?? null, filter.unitId ?? null, filter.status ?? null)
      .all<PricingRuleRow>();
    return results;
  }

  findRule(id: string): Promise<PricingRuleRow | null> {
    return this.db.prepare(`SELECT ${RULE_COLUMNS} FROM pricing_settings WHERE id = ?1`).bind(id).first<PricingRuleRow>();
  }

  insertRuleStatement(r: Omit<PricingRuleRow, "created_at" | "updated_at">, createdBy: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO pricing_settings (id, target_type, unit_id, unit_type, name, date_from, date_to, days_of_week, price_satang,
           priority, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
      )
      .bind(r.id, r.target_type, r.unit_id, r.unit_type, r.name, r.date_from, r.date_to, r.days_of_week, r.price_satang,
        r.priority, r.status, createdBy, now);
  }

  updateRuleStatement(r: Omit<PricingRuleRow, "created_at" | "updated_at">, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE pricing_settings SET target_type = ?2, unit_id = ?3, unit_type = ?4, name = ?5, date_from = ?6, date_to = ?7,
           days_of_week = ?8, price_satang = ?9, priority = ?10, status = ?11, updated_at = ?12
         WHERE id = ?1`,
      )
      .bind(r.id, r.target_type, r.unit_id, r.unit_type, r.name, r.date_from, r.date_to, r.days_of_week, r.price_satang,
        r.priority, r.status, now);
  }

  // ------------------------------------------------------------------ food

  async activeFoodCategories(): Promise<FoodCategoryRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, code, default_daily_capacity, deadline_type, deadline_days_before, deadline_time, service_time,
                service_day_offset, sort_order, status
           FROM food_categories WHERE status = 'ACTIVE' ORDER BY sort_order, code`,
      )
      .all<FoodCategoryRow>();
    return results;
  }

  async activeFoodOptions(): Promise<FoodOptionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT o.id, o.food_category_id, o.code, o.pricing_type, o.price_satang, o.child_pricing, o.child_price_satang,
                o.persons_per_set, o.min_quantity, o.max_quantity, o.status, o.sort_order,
                m.id AS image_asset_id, m.object_key AS image_key, m.width AS image_width, m.height AS image_height
           FROM food_options o JOIN food_categories c ON c.id = o.food_category_id AND c.status = 'ACTIVE'
           LEFT JOIN media_assets m ON m.id = o.image_asset_id AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE'
          WHERE o.status = 'ACTIVE' ORDER BY c.sort_order, o.sort_order, o.code`,
      )
      .all<FoodOptionRow>();
    return results;
  }

  async foodCategoryTranslations(): Promise<NamedTranslationRow[]> {
    const { results } = await this.db
      .prepare("SELECT food_category_id AS id, language_code, name, description FROM food_category_translations")
      .all<NamedTranslationRow>();
    return results;
  }

  async foodOptionTranslations(): Promise<NamedTranslationRow[]> {
    const { results } = await this.db
      .prepare("SELECT food_option_id AS id, language_code, name, description, allergens FROM food_option_translations")
      .all<NamedTranslationRow>();
    return results;
  }

  async foodCapacity(from: string, toInclusive: string): Promise<FoodCapacityRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT food_category_id, service_date, max_quantity, used_quantity FROM food_daily_capacity
          WHERE service_date >= ?1 AND service_date <= ?2`,
      )
      .bind(from, toInclusive)
      .all<FoodCapacityRow>();
    return results;
  }

  /** Included meals that apply to a unit (UNIT or its UNIT_TYPE) or to own-tent camping. */
  async includedMeals(target: { unitId: string; unitType: string } | "CAMPING"): Promise<IncludedMealRow[]> {
    const unitId = target === "CAMPING" ? null : target.unitId;
    const unitType = target === "CAMPING" ? null : target.unitType;
    const { results } = await this.db
      .prepare(
        `SELECT m.id, m.target_type, m.food_category_id, m.food_option_id, m.persons_per_night
           FROM included_meals m JOIN food_categories c ON c.id = m.food_category_id
          WHERE m.status = 'ACTIVE'
            AND ((?1 IS NULL AND m.target_type = 'CAMPING')
              OR (?1 IS NOT NULL AND ((m.target_type = 'UNIT' AND m.unit_id = ?1) OR (m.target_type = 'UNIT_TYPE' AND m.unit_type = ?2))))
          ORDER BY c.sort_order, m.id`,
      )
      .bind(unitId, unitType)
      .all<IncludedMealRow>();
    return results;
  }

  async bookingSettings(): Promise<BookingSettingsRow> {
    const row = await this.db
      .prepare("SELECT hold_minutes, max_nights, max_advance_days, max_tents_per_booking FROM booking_settings WHERE id = 1")
      .first<BookingSettingsRow>();
    return row ?? { hold_minutes: 60, max_nights: 30, max_advance_days: 365, max_tents_per_booking: 10 };
  }
}
