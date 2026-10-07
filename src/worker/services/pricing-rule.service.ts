import type { PricingRuleDto, PricingRuleInput } from "../../shared/booking-types.ts";
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
    return (await this.repo.listRules(filter)).map(toDto);
  }

  async create(actor: AuthContext, input: PricingRuleInput, meta: RequestMeta): Promise<PricingRuleDto> {
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    await this.checkTarget(input);
    const row = toRow(newId(), input);
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.insertRuleStatement(row, actor.userId, now),
      this.historyStatement(row.id, null, row.price_satang, actor.userId, now, "create"),
      this.log.auditStatement(actor.userId, "CREATE_PRICING_RULE", "pricing", row.id, null, input, meta),
    ]);
    return toDto((await this.repo.findRule(row.id))!);
  }

  async update(actor: AuthContext, id: string, patch: Partial<PricingRuleInput>, meta: RequestMeta): Promise<PricingRuleDto> {
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    const current = await this.repo.findRule(id);
    if (!current) throw new NotFoundError("Pricing rule not found", "PRICING_RULE_NOT_FOUND");
    const before = toDto(current);
    const merged: PricingRuleInput = { ...before, ...patch };
    // Changing the target type resets the other target field.
    if (merged.targetType !== "UNIT") merged.unitId = null;
    if (merged.targetType !== "UNIT_TYPE") merged.unitType = null;
    if (merged.dateTo < merged.dateFrom) throw new ValidationError({ dateTo: "BEFORE_START" });
    await this.checkTarget(merged);
    const row = toRow(id, merged);
    const now = iso(this.clock());
    const statements = [
      this.repo.updateRuleStatement(row, now),
      this.log.auditStatement(actor.userId, "UPDATE_PRICING_RULE", "pricing", id, omitMeta(before), merged, meta),
    ];
    if (row.price_satang !== current.price_satang) {
      statements.push(this.historyStatement(id, current.price_satang, row.price_satang, actor.userId, now, "update"));
    }
    await this.db.batch(statements);
    return toDto((await this.repo.findRule(id))!);
  }

  private async checkTarget(input: PricingRuleInput): Promise<void> {
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
    updatedAt: r.updated_at,
  };
}

function omitMeta(d: PricingRuleDto): PricingRuleInput {
  const { id: _id, updatedAt: _u, ...rest } = d;
  return rest;
}
