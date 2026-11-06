import { withFallback } from "./schema-fallback.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

/** A perk of a promotion as stored for a rule: its id and names per language (migration 0056). */
export interface PerkRef {
  id: string;
  names: Record<string, string>;
}

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
  /** Pay-now percentage of the nights this rule prices (migration 0049); null = the stay's own plan. */
  pay_now_percent?: number | null;
  /** Several houses edited as one rule (migration 0051); null = a rule on its own. */
  group_id?: string | null;
  /** Promotion (migration 0055): room discount on this rule's price, free extra beds / pets / food, text for guests. */
  discount_kind?: "PERCENT" | "AMOUNT" | null;
  discount_value?: number | null;
  free_extra_bed?: number;
  free_pets?: number;
  promo_text?: string | null;
  free_food_ids?: string[];
  /** The free dishes that can still be ordered, with their names per language (for guests). */
  free_foods?: PerkRef[];
  /** Extra perks of the promotion (migration 0056), from the shared list, with their names per language. */
  perks?: PerkRef[];
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
    return this.withPayNow(results);
  }

  /**
   * Adds each rule's pay-now percentage (migration 0049) and group (0051) — read on their own so prices never depend
   * on the new columns during a deploy.
   */
  private async withPayNow(rules: PricingRuleRow[]): Promise<PricingRuleRow[]> {
    if (!rules.length) return rules;
    type Extra = { id: string; pay_now_percent: number | null; group_id: string | null };
    const ids = JSON.stringify(rules.map((r) => r.id));
    const rows = await withFallback(
      async () => (await this.db
        .prepare(`SELECT id, pay_now_percent, group_id FROM pricing_settings
                   WHERE id IN (SELECT value FROM json_each(?1)) AND (pay_now_percent IS NOT NULL OR group_id IS NOT NULL)`)
        .bind(ids).all<Extra>()).results,
      () => withFallback(
        async () => (await this.db
          .prepare("SELECT id, pay_now_percent, NULL AS group_id FROM pricing_settings WHERE id IN (SELECT value FROM json_each(?1)) AND pay_now_percent IS NOT NULL")
          .bind(ids).all<Extra>()).results,
        async () => [] as Extra[],
      ),
    );
    const extra = new Map(rows.map((r) => [r.id, r]));
    return this.withPromotions(rules.map((r) => ({ ...r, pay_now_percent: extra.get(r.id)?.pay_now_percent ?? null, group_id: extra.get(r.id)?.group_id ?? null })));
  }

  /**
   * Adds each rule's promotion (migration 0055): discount, free extra beds / pets, text and free food options. Read on
   * its own (none before the migration), so prices never depend on the new columns during a deploy.
   */
  async withPromotions(rules: PricingRuleRow[]): Promise<PricingRuleRow[]> {
    if (!rules.length) return rules;
    type Promo = { id: string; discount_kind: "PERCENT" | "AMOUNT" | null; discount_value: number | null; free_extra_bed: number; free_pets: number; promo_text: string | null };
    const ids = JSON.stringify(rules.map((r) => r.id));
    const [promos, foods] = await withFallback(
      async () => Promise.all([
        this.db.prepare(`SELECT id, discount_kind, discount_value, free_extra_bed, free_pets, promo_text FROM pricing_settings
                          WHERE id IN (SELECT value FROM json_each(?1))
                            AND (discount_kind IS NOT NULL OR free_extra_bed = 1 OR free_pets = 1 OR promo_text IS NOT NULL
                              OR EXISTS (SELECT 1 FROM pricing_rule_free_foods f WHERE f.rule_id = pricing_settings.id))`)
          .bind(ids).all<Promo>().then((r) => r.results),
        this.db.prepare("SELECT rule_id, option_id FROM pricing_rule_free_foods WHERE rule_id IN (SELECT value FROM json_each(?1)) ORDER BY option_id")
          .bind(ids).all<{ rule_id: string; option_id: string }>().then((r) => r.results),
      ]),
      async () => [[] as Promo[], [] as { rule_id: string; option_id: string }[]] as const,
    );
    const foodNames = foods.length ? await this.foodNames(foods.map((f) => f.option_id)) : new Map<string, PerkRef>();
    const perks = await this.rulePerks(ids);
    if (!promos.length && !perks.size) return rules;
    const byId = new Map(promos.map((p) => [p.id, p]));
    return rules.map((r) => {
      const p = byId.get(r.id);
      const rp = perks.get(r.id);
      if (!p) return rp ? { ...r, perks: rp } : r;
      const discountOk = (p.discount_kind === "PERCENT" || p.discount_kind === "AMOUNT") && (p.discount_value ?? 0) > 0;
      return {
        ...r,
        discount_kind: discountOk ? p.discount_kind : null,
        discount_value: discountOk ? p.discount_value : null,
        free_extra_bed: p.free_extra_bed,
        free_pets: p.free_pets,
        promo_text: p.promo_text,
        free_food_ids: foods.filter((f) => f.rule_id === r.id).map((f) => f.option_id),
        free_foods: foods.filter((f) => f.rule_id === r.id).flatMap((f) => foodNames.get(f.option_id) ?? []),
        ...(rp ? { perks: rp } : {}),
      };
    });
  }

  /** Names per language of the dishes guests can order (active), in the menu's order. */
  private async foodNames(optionIds: string[]): Promise<Map<string, PerkRef>> {
    type Row = { id: string; language_code: string; name: string };
    const { results } = await this.db
      .prepare(`SELECT o.id, t.language_code, t.name
                  FROM food_options o
                  JOIN food_categories c ON c.id = o.food_category_id
                  JOIN food_option_translations t ON t.food_option_id = o.id
                 WHERE o.id IN (SELECT value FROM json_each(?1)) AND o.status = 'ACTIVE'
                 ORDER BY c.sort_order, o.sort_order, o.id`)
      .bind(JSON.stringify([...new Set(optionIds)])).all<Row>();
    const out = new Map<string, PerkRef>();
    for (const r of results) {
      const ref = out.get(r.id) ?? { id: r.id, names: {} };
      ref.names[r.language_code] = r.name;
      out.set(r.id, ref);
    }
    return out;
  }

  /** The perks of these rules (migration 0056; none before it), in the shared list's order, with their names. */
  private async rulePerks(idsJson: string): Promise<Map<string, PerkRef[]>> {
    type Row = { rule_id: string; perk_id: string; language_code: string | null; name: string | null };
    const rows = await withFallback(
      async () => (await this.db
        .prepare(`SELECT rp.rule_id, rp.perk_id, t.language_code, t.name
                    FROM pricing_rule_perks rp
                    JOIN promotion_perks p ON p.id = rp.perk_id AND p.status = 'ACTIVE'
                    LEFT JOIN promotion_perk_translations t ON t.perk_id = rp.perk_id
                   WHERE rp.rule_id IN (SELECT value FROM json_each(?1))
                   ORDER BY p.sort_order, p.created_at, p.id`)
        .bind(idsJson).all<Row>()).results,
      async () => [] as Row[],
    );
    const out = new Map<string, PerkRef[]>();
    for (const r of rows) {
      const list = out.get(r.rule_id) ?? [];
      let perk = list.find((x) => x.id === r.perk_id);
      if (!perk) { perk = { id: r.perk_id, names: {} }; list.push(perk); }
      if (r.language_code && r.name) perk.names[r.language_code] = r.name;
      out.set(r.rule_id, list);
    }
    return out;
  }

  /** Replaces a rule's perks (migration 0056). */
  perkStatements(ruleId: string, perkIds: string[]): D1PreparedStatementLike[] {
    return [
      this.db.prepare("DELETE FROM pricing_rule_perks WHERE rule_id = ?1").bind(ruleId),
      ...perkIds.map((perkId) => this.db.prepare("INSERT INTO pricing_rule_perks (rule_id, perk_id) VALUES (?1, ?2)").bind(ruleId, perkId)),
    ];
  }

  /** Writes a rule's promotion (migration 0055): the columns, then its free food options (replaced). */
  promotionStatements(id: string, p: { discountKind: "PERCENT" | "AMOUNT" | null; discountValue: number | null; freeExtraBed: boolean; freePets: boolean; promoText: string | null; freeFoodIds: string[] }): D1PreparedStatementLike[] {
    return [
      this.db.prepare("UPDATE pricing_settings SET discount_kind = ?2, discount_value = ?3, free_extra_bed = ?4, free_pets = ?5, promo_text = ?6 WHERE id = ?1")
        .bind(id, p.discountKind, p.discountValue, p.freeExtraBed ? 1 : 0, p.freePets ? 1 : 0, p.promoText),
      this.db.prepare("DELETE FROM pricing_rule_free_foods WHERE rule_id = ?1").bind(id),
      ...p.freeFoodIds.map((optionId) => this.db.prepare("INSERT INTO pricing_rule_free_foods (rule_id, option_id) VALUES (?1, ?2)").bind(id, optionId)),
    ];
  }

  /** Every rule of a group (none before migration 0051). */
  async groupRules(groupId: string): Promise<PricingRuleRow[]> {
    const ids = await withFallback(
      async () => (await this.db.prepare("SELECT id FROM pricing_settings WHERE group_id = ?1 ORDER BY created_at, id")
        .bind(groupId).all<{ id: string }>()).results.map((r) => r.id),
      async () => [] as string[],
    );
    if (!ids.length) return [];
    const { results } = await this.db
      .prepare(`SELECT ${RULE_COLUMNS} FROM pricing_settings WHERE id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(ids))
      .all<PricingRuleRow>();
    return this.withPayNow(results);
  }

  /** Puts a rule in a group, or takes it out (null). */
  setGroupStatement(id: string, groupId: string | null): D1PreparedStatementLike {
    return this.db.prepare("UPDATE pricing_settings SET group_id = ?2 WHERE id = ?1").bind(id, groupId);
  }

  /** Sets (or clears) a rule's pay-now percentage (migration 0049). */
  setPayNowStatement(id: string, percent: number | null): D1PreparedStatementLike {
    return this.db.prepare("UPDATE pricing_settings SET pay_now_percent = ?2 WHERE id = ?1").bind(id, percent);
  }

  /** Every active house / VIP-tent rule overlapping [from, toInclusive] — one read for a whole availability search. */
  async activeUnitRules(from: string, toInclusive: string): Promise<PricingRuleRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${RULE_COLUMNS} FROM pricing_settings
          WHERE status = 'ACTIVE' AND date_from <= ?1 AND date_to >= ?2 AND target_type IN ('UNIT', 'UNIT_TYPE')`,
      )
      .bind(toInclusive, from)
      .all<PricingRuleRow>();
    // Discounts change the price (migration 0055).
    return this.withPromotions(results);
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
    return this.withPayNow(results);
  }

  async findRule(id: string): Promise<PricingRuleRow | null> {
    const row = await this.db.prepare(`SELECT ${RULE_COLUMNS} FROM pricing_settings WHERE id = ?1`).bind(id).first<PricingRuleRow>();
    return row ? (await this.withPayNow([row]))[0]! : null;
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

  /** Every food option id (any status), to check the free foods of a promotion. */
  async allFoodOptionIds(): Promise<string[]> {
    const { results } = await this.db.prepare("SELECT id FROM food_options").all<{ id: string }>();
    return results.map((r) => r.id);
  }

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
