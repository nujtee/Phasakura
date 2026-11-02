import { MAX_DISCOUNT_PERCENT, type PricingRuleDto, type PricingRuleInput, type PromotionPerkDto } from "../../shared/booking-types.ts";
import { PromotionPerkRepository, type PromotionPerkRow } from "../repositories/promotion-perk.repository.ts";
import type { D1DatabaseLike } from "../env.ts";
import { NotFoundError, ValidationError } from "../http/errors.ts";
import type { AccommodationRepository } from "../repositories/accommodation.repository.ts";
import type { PricingRepository, PricingRuleRow } from "../repositories/pricing.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

/**
 * Seasonal / weekday price rules (spec §17). Changing a rule never touches existing
 * bookings: they keep their price snapshot. Rules are deactivated, never deleted.
 */
export class PricingRuleService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: PricingRepository,
    private readonly units: AccommodationRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  async list(actor: AuthContext, filter: { targetType?: string; unitId?: string; status?: string }, meta: RequestMeta): Promise<PricingRuleDto[]> {
    await this.authz.requirePermission(actor, "accommodation.view", meta);
    const groups = filter.targetType === "UNITS";
    const rows = await this.repo.listRules({ ...filter, targetType: groups ? "UNIT" : filter.targetType });
    const out = groupDtos(rows);
    return filter.targetType ? out.filter((d) => d.targetType === filter.targetType) : out;
  }

  async create(actor: AuthContext, input: PricingRuleInput, meta: RequestMeta): Promise<PricingRuleDto> {
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    await this.checkTarget(input);
    await this.checkPromotion(input);
    const now = iso(this.clock());
    if (input.targetType === "UNITS") {
      // A group: one UNIT rule per house, sharing the group id (the price engine reads them like any UNIT rule).
      const groupId = newId();
      const statements = input.unitIds!.flatMap((unitId) => {
        const row = toRow(newId(), { ...input, targetType: "UNIT", unitId });
        return [
          this.repo.insertRuleStatement(row, actor.userId, now),
          this.repo.setGroupStatement(row.id, groupId),
          ...(row.pay_now_percent !== null ? [this.repo.setPayNowStatement(row.id, row.pay_now_percent ?? null)] : []),
          ...this.promoStatements(row.id, input, null),
          this.historyStatement(row.id, null, row.price_satang, actor.userId, now, "create"),
        ];
      });
      await this.db.batch([...statements, this.log.auditStatement(actor.userId, "CREATE_PRICING_RULE", "pricing", groupId, null, input, meta)]);
      return groupDtos(await this.repo.groupRules(groupId))[0]!;
    }
    const row = toRow(newId(), input);
    await this.db.batch([
      this.repo.insertRuleStatement(row, actor.userId, now),
      ...(row.pay_now_percent !== null ? [this.repo.setPayNowStatement(row.id, row.pay_now_percent ?? null)] : []),
      ...this.promoStatements(row.id, input, null),
      this.historyStatement(row.id, null, row.price_satang, actor.userId, now, "create"),
      this.log.auditStatement(actor.userId, "CREATE_PRICING_RULE", "pricing", row.id, null, input, meta),
    ]);
    return toDto((await this.repo.findRule(row.id))!);
  }

  async update(actor: AuthContext, id: string, patch: Partial<PricingRuleInput>, meta: RequestMeta): Promise<PricingRuleDto> {
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    const members = await this.repo.groupRules(id);
    if (members.length) return this.updateGroup(actor, id, members, patch, meta);
    const current = await this.repo.findRule(id);
    if (!current) throw new NotFoundError("Pricing rule not found", "PRICING_RULE_NOT_FOUND");
    // A member is edited through its group.
    if (current.group_id) throw new ValidationError({ id: "PART_OF_GROUP" });
    if (patch.targetType === "UNITS") throw new ValidationError({ targetType: "CANNOT_BECOME_GROUP" });
    const before = toDto(current);
    const merged: PricingRuleInput = { ...before, ...patch };
    // Changing the target type resets the other target field.
    if (merged.targetType !== "UNIT") merged.unitId = null;
    if (merged.targetType !== "UNIT_TYPE") merged.unitType = null;
    if (merged.dateTo < merged.dateFrom) throw new ValidationError({ dateTo: "BEFORE_START" });
    await this.checkTarget(merged);
    await this.checkPromotion(merged);
    const row = toRow(id, merged);
    const now = iso(this.clock());
    const statements = [
      this.repo.updateRuleStatement(row, now),
      // Only when it changes, so other edits keep working before migration 0049.
      ...((row.pay_now_percent ?? null) !== (current.pay_now_percent ?? null) ? [this.repo.setPayNowStatement(id, row.pay_now_percent ?? null)] : []),
      ...this.promoStatements(id, merged, current),
      this.log.auditStatement(actor.userId, "UPDATE_PRICING_RULE", "pricing", id, omitMeta(before), merged, meta),
    ];
    if (row.price_satang !== current.price_satang) {
      statements.push(this.historyStatement(id, current.price_satang, row.price_satang, actor.userId, now, "update"));
    }
    await this.db.batch(statements);
    return toDto((await this.repo.findRule(id))!);
  }

  /**
   * A group: every member gets the same fields; houses added get a new member, houses taken out keep their rule
   * switched off and out of the group (nothing is deleted; price history stays).
   */
  private async updateGroup(actor: AuthContext, groupId: string, members: PricingRuleRow[], patch: Partial<PricingRuleInput>, meta: RequestMeta): Promise<PricingRuleDto> {
    if (patch.targetType && patch.targetType !== "UNITS") throw new ValidationError({ targetType: "GROUP_STAYS_GROUP" });
    const before = groupDtos(members)[0]!;
    const merged: PricingRuleInput = { ...before, ...patch, targetType: "UNITS", unitId: null, unitType: null };
    if (merged.dateTo < merged.dateFrom) throw new ValidationError({ dateTo: "BEFORE_START" });
    await this.checkTarget(merged);
    await this.checkPromotion(merged);
    const now = iso(this.clock());
    const wanted = new Set(merged.unitIds!);
    const statements = [];
    for (const m of members) {
      if (wanted.has(m.unit_id!)) {
        const row = toRow(m.id, { ...merged, targetType: "UNIT", unitId: m.unit_id });
        statements.push(this.repo.updateRuleStatement(row, now));
        if ((row.pay_now_percent ?? null) !== (m.pay_now_percent ?? null)) statements.push(this.repo.setPayNowStatement(m.id, row.pay_now_percent ?? null));
        statements.push(...this.promoStatements(m.id, merged, m));
        if (row.price_satang !== m.price_satang) statements.push(this.historyStatement(m.id, m.price_satang, row.price_satang, actor.userId, now, "update"));
      } else {
        statements.push(this.repo.updateRuleStatement({ ...stripMeta(m), status: "INACTIVE" }, now), this.repo.setGroupStatement(m.id, null));
      }
    }
    const have = new Set(members.map((m) => m.unit_id));
    for (const unitId of merged.unitIds!) {
      if (have.has(unitId)) continue;
      const row = toRow(newId(), { ...merged, targetType: "UNIT", unitId });
      statements.push(
        this.repo.insertRuleStatement(row, actor.userId, now),
        this.repo.setGroupStatement(row.id, groupId),
        ...(row.pay_now_percent !== null ? [this.repo.setPayNowStatement(row.id, row.pay_now_percent ?? null)] : []),
        ...this.promoStatements(row.id, merged, null),
        this.historyStatement(row.id, null, row.price_satang, actor.userId, now, "create"),
      );
    }
    statements.push(this.log.auditStatement(actor.userId, "UPDATE_PRICING_RULE", "pricing", groupId, omitMeta(before), merged, meta));
    await this.db.batch(statements);
    return groupDtos(await this.repo.groupRules(groupId))[0]!;
  }

  /** Promotion fields (migration 0055): a discount needs both its kind and value; foods must exist. */
  private async checkPromotion(input: PricingRuleInput): Promise<void> {
    const kind = input.discountKind ?? null;
    const value = input.discountValue ?? null;
    if ((kind === null) !== (value === null)) throw new ValidationError({ discountValue: kind ? "REQUIRED" : "KIND_REQUIRED" });
    if (kind === "PERCENT" && (value! < 1 || value! > MAX_DISCOUNT_PERCENT)) throw new ValidationError({ discountValue: "PERCENT_RANGE" });
    if (kind === "AMOUNT" && (value! < 100 || value! % 100 !== 0 || value! > input.priceSatang)) throw new ValidationError({ discountValue: "AMOUNT_RANGE" });
    const perkIds = input.perkIds ?? [];
    if (perkIds.length) {
      const active = new Set((await this.perks.list()).map((p) => p.id));
      if (!perkIds.every((p) => active.has(p))) throw new ValidationError({ perkIds: "UNKNOWN_PERK" });
    }
    const foods = input.freeFoodOptionIds ?? [];
    if (foods.length) {
      const known = new Set((await this.repo.allFoodOptionIds()));
      if (!foods.every((f) => known.has(f))) throw new ValidationError({ freeFoodOptionIds: "UNKNOWN_FOOD" });
    }
  }

  /** Writes the promotion only when it differs (or a rule is new and has one), so rules work before migration 0055. */
  private promoStatements(id: string, input: PricingRuleInput, current: PricingRuleRow | null) {
    const want = promoOf(input);
    const have = current ? promoOfRow(current) : promoOf({} as PricingRuleInput);
    // Perks (migration 0056) on their own: only written when they change, so rules work before that migration.
    const perksWant = [...new Set(input.perkIds ?? [])].sort();
    const perksHave = (current?.perks ?? []).map((p) => p.id).sort();
    return [
      ...(JSON.stringify(want) === JSON.stringify(have) ? [] : this.repo.promotionStatements(id, { ...want, freeFoodIds: want.freeFoodIds })),
      ...(JSON.stringify(perksWant) === JSON.stringify(perksHave) ? [] : this.repo.perkStatements(id, perksWant)),
    ];
  }

  // ================================================================ promotion perks (migration 0056)

  private get perks(): PromotionPerkRepository {
    return new PromotionPerkRepository(this.db);
  }

  async listPerks(actor: AuthContext, meta: RequestMeta): Promise<PromotionPerkDto[]> {
    await this.authz.requirePermission(actor, "accommodation.view", meta);
    return (await this.perks.list()).map(toPerkDto);
  }

  async createPerk(actor: AuthContext, names: Record<string, string>, meta: RequestMeta): Promise<PromotionPerkDto> {
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    const id = newId();
    const now = iso(this.clock());
    await this.db.batch([
      this.perks.insertStatement(id, await this.perks.nextSortOrder(), now),
      ...this.perks.namesStatements(id, names, now),
      this.log.auditStatement(actor.userId, "CREATE_PROMOTION_PERK", "pricing", id, null, { names }, meta),
    ]);
    return toPerkDto((await this.perks.list()).find((p) => p.id === id)!);
  }

  async updatePerk(actor: AuthContext, id: string, names: Record<string, string>, meta: RequestMeta): Promise<PromotionPerkDto> {
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    const current = (await this.perks.list()).find((p) => p.id === id);
    if (!current) throw new NotFoundError("Perk not found", "PERK_NOT_FOUND");
    const now = iso(this.clock());
    await this.db.batch([
      ...this.perks.namesStatements(id, names, now),
      this.log.auditStatement(actor.userId, "UPDATE_PROMOTION_PERK", "pricing", id, { names: current.names }, { names }, meta),
    ]);
    return toPerkDto((await this.perks.list()).find((p) => p.id === id)!);
  }

  /** Off every price rule and out of the list; bookings already made keep the name on their bill. */
  async removePerk(actor: AuthContext, id: string, meta: RequestMeta): Promise<{ removed: true; rules: number }> {
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    const current = (await this.perks.list()).find((p) => p.id === id);
    if (!current) throw new NotFoundError("Perk not found", "PERK_NOT_FOUND");
    await this.db.batch([
      ...this.perks.removeStatements(id, iso(this.clock())),
      this.log.auditStatement(actor.userId, "DELETE_PROMOTION_PERK", "pricing", id, { names: current.names }, null, meta),
    ]);
    return { removed: true, rules: current.rule_count };
  }

  private async checkTarget(input: PricingRuleInput): Promise<void> {
    if (input.targetType === "UNITS") {
      const ids = input.unitIds ?? [];
      if (!ids.length) throw new ValidationError({ unitIds: "REQUIRED" });
      for (const id of ids) {
        const unit = await this.units.findUnit(id);
        if (!unit || unit.status === "DELETED") throw new ValidationError({ unitIds: "UNKNOWN_UNIT" });
      }
      return;
    }
    if (input.targetType === "UNIT") {
      const unit = input.unitId ? await this.units.findUnit(input.unitId) : null;
      if (!unit || unit.status === "DELETED") throw new ValidationError({ unitId: "UNKNOWN_UNIT" });
    }
    if (input.targetType === "UNIT_TYPE" && !input.unitType) throw new ValidationError({ unitType: "REQUIRED" });
  }

  private historyStatement(ruleId: string, oldPrice: number | null, newPrice: number, by: string, now: string, reason: string) {
    return this.db
      .prepare(
        `INSERT INTO price_history (id, entity_type, entity_id, old_price_satang, new_price_satang, changed_by, changed_at, reason)
         VALUES (?1, 'PRICING_RULE', ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(newId(), ruleId, oldPrice, newPrice, by, now, reason);
  }
}

function toRow(id: string, r: PricingRuleInput): Omit<PricingRuleRow, "created_at" | "updated_at"> {
  if (r.targetType === "UNITS") throw new Error("a group is stored as UNIT rules");
  return {
    id,
    target_type: r.targetType,
    unit_id: r.targetType === "UNIT" ? r.unitId : null,
    unit_type: r.targetType === "UNIT_TYPE" ? r.unitType : null,
    name: r.name,
    date_from: r.dateFrom,
    date_to: r.dateTo,
    days_of_week: [...new Set(r.daysOfWeek)].sort().join(""),
    price_satang: r.priceSatang,
    priority: r.priority,
    status: r.status,
    pay_now_percent: r.payNowPercent ?? null,
  };
}

function toDto(r: PricingRuleRow): PricingRuleDto {
  return {
    id: r.id,
    targetType: r.target_type,
    unitId: r.unit_id,
    unitType: r.unit_type,
    name: r.name,
    dateFrom: r.date_from,
    dateTo: r.date_to,
    daysOfWeek: r.days_of_week,
    priceSatang: r.price_satang,
    priority: r.priority,
    status: r.status,
    payNowPercent: r.pay_now_percent ?? null,
    discountKind: r.discount_kind ?? null,
    discountValue: r.discount_value ?? null,
    freeExtraBed: r.free_extra_bed === 1,
    freePets: r.free_pets === 1,
    freeFoodOptionIds: r.free_food_ids ?? [],
    promoText: r.promo_text ?? null,
    perkIds: (r.perks ?? []).map((p) => p.id),
    updatedAt: r.updated_at,
  };
}

function promoOf(r: Partial<PricingRuleInput>) {
  return {
    discountKind: r.discountKind ?? null, discountValue: r.discountKind ? r.discountValue ?? null : null,
    freeExtraBed: !!r.freeExtraBed, freePets: !!r.freePets, promoText: r.promoText ?? null, freeFoodIds: [...(r.freeFoodOptionIds ?? [])].sort(),
  };
}

function promoOfRow(r: PricingRuleRow) {
  return promoOf({
    discountKind: r.discount_kind ?? null, discountValue: r.discount_value ?? null, freeExtraBed: r.free_extra_bed === 1,
    freePets: r.free_pets === 1, promoText: r.promo_text ?? null, freeFoodOptionIds: r.free_food_ids ?? [],
  });
}

function omitMeta(d: PricingRuleDto): PricingRuleInput {
  const { id: _id, updatedAt: _u, ...rest } = d;
  return rest;
}

function stripMeta(r: PricingRuleRow): Omit<PricingRuleRow, "created_at" | "updated_at"> {
  const { created_at: _c, updated_at: _u, group_id: _g, discount_kind: _dk, discount_value: _dv, free_extra_bed: _fe, free_pets: _fp, promo_text: _pt, free_food_ids: _ff, perks: _pk, ...rest } = r;
  return rest;
}

/**
 * Admin list: rules on their own as they are; the members of a group as one rule (targetType UNITS) with the group
 * id, every member's house and the fields they share (taken from the newest-edited member).
 */
export function groupDtos(rows: PricingRuleRow[]): PricingRuleDto[] {
  const order: (PricingRuleDto | string)[] = [];
  const groups = new Map<string, PricingRuleRow[]>();
  for (const r of rows) {
    if (!r.group_id) {
      order.push(toDto(r));
      continue;
    }
    if (!groups.has(r.group_id)) {
      groups.set(r.group_id, []);
      order.push(r.group_id); // keeps the list order
    }
    groups.get(r.group_id)!.push(r);
  }
  return order.map((entry) => {
    if (typeof entry !== "string") return entry;
    const members = groups.get(entry)!;
    const lead = [...members].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!;
    return { ...toDto(lead), id: entry, targetType: "UNITS" as const, unitId: null, unitType: null, unitIds: members.map((m) => m.unit_id!).sort() };
  });
}

function toPerkDto(p: PromotionPerkRow): PromotionPerkDto {
  return { id: p.id, names: p.names, status: p.status, ruleCount: p.rule_count };
}
