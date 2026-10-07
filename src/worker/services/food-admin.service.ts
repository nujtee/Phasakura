import type { BookingStatus, PaymentStatus } from "../../shared/booking-types.ts";
import { addDays, diffDays, isIsoDate, todayIn, DEFAULT_TIMEZONE } from "../../shared/dates.ts";
import {
  FOOD_ORDER_FLOW, FOOD_ORDER_STATUSES,
  type FoodCapacityDto, type FoodCategoryRefDto, type FoodOrderDto, type FoodOrderStatus,
} from "../../shared/food-admin-types.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { FoodAdminRepository } from "../repositories/food-admin.repository.ts";
import type { InventoryRepository } from "../repositories/inventory.repository.ts";
import { ID_PATTERN } from "../validation.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

const MAX_DAYS = 62;
/** A kitchen order is only worked on once the booking is paid / in house. */
const WORKABLE_BOOKING = new Set(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT"]);

export class FoodAdminService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: FoodAdminRepository,
    private readonly inventory: InventoryRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  private async today(): Promise<string> {
    return todayIn((await this.inventory.siteTimezone()) ?? DEFAULT_TIMEZONE, this.clock());
  }

  private range(from: string | undefined, to: string | undefined, today: string, defaultDays: number) {
    const start = from ?? today;
    const end = to ?? addDays(start, defaultDays);
    if (!isIsoDate(start)) throw new ValidationError({ from: "INVALID_DATE" });
    if (!isIsoDate(end)) throw new ValidationError({ to: "INVALID_DATE" });
    const days = diffDays(start, end);
    if (days < 1 || days > MAX_DAYS) throw new ValidationError({ to: "RANGE_TOO_LONG" });
    return { start, end, days };
  }

  private async categoryRefs(): Promise<FoodCategoryRefDto[]> {
    const map = new Map<string, FoodCategoryRefDto>();
    for (const r of await this.repo.categories()) {
      const c = map.get(r.id) ?? { id: r.id, code: r.code, names: {}, defaultDailyCapacity: r.default_daily_capacity, serviceTime: r.service_time, status: r.status };
      if (r.language_code && r.name) c.names[r.language_code as LocaleCode] = r.name;
      map.set(r.id, c);
    }
    return [...map.values()];
  }

  // ================================================================ capacity (spec §22)

  async capacity(actor: AuthContext, from: string | undefined, to: string | undefined, meta: RequestMeta): Promise<FoodCapacityDto> {
    await this.authz.requirePermission(actor, "food.view", meta);
    const { start, end, days } = this.range(from, to, await this.today(), 14);
    const [categories, rows] = await Promise.all([this.categoryRefs(), this.repo.capacityRows(start, end)]);
    const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
    const byKey = new Map(rows.map((r) => [`${r.food_category_id}|${r.service_date}`, r]));
    return {
      from: start,
      to: end,
      dates,
      categories,
      cells: categories.flatMap((c) => dates.map((date) => {
        const row = byKey.get(`${c.id}|${date}`);
        if (c.defaultDailyCapacity === null) return { categoryId: c.id, date, max: null, used: row?.used_quantity ?? 0, overridden: false };
        return {
          categoryId: c.id, date, max: row?.max_quantity ?? c.defaultDailyCapacity, used: row?.used_quantity ?? 0,
          overridden: !!row && row.max_quantity !== c.defaultDailyCapacity,
        };
      })),
    };
  }

  /** Per-day limit. Lowering below portions already sold is refused by the DB CHECK. null = back to the default. */
  async setCapacity(actor: AuthContext, categoryId: string, date: string, max: number | null, meta: RequestMeta): Promise<FoodCapacityDto> {
    await this.authz.requirePermission(actor, "food.edit", meta);
    if (!isIsoDate(date)) throw new ValidationError({ date: "INVALID_DATE" });
    const category = ID_PATTERN.test(categoryId) ? await this.repo.category(categoryId) : null;
    if (!category) throw new NotFoundError("Food category not found", "RECORD_NOT_FOUND");
    if (category.default_daily_capacity === null) throw new ConflictError("This meal has no daily limit", "CATEGORY_UNLIMITED");
    const today = await this.today();
    if (date < today) throw new ValidationError({ date: "DATE_IN_PAST" });
    const target = max ?? category.default_daily_capacity;
    const before = await this.repo.capacityRow(categoryId, date);
    if (before && target < before.used_quantity) throw new ConflictError("Fewer portions than already sold", "CAPACITY_BELOW_USED");
    try {
      await this.db.batch([
        this.repo.setCapacityStatement(categoryId, date, target, iso(this.clock())),
        this.log.auditStatement(actor.userId, "SET_FOOD_CAPACITY", "food", `${category.code}:${date}`,
          before ? { max: before.max_quantity } : null, { max: target }, meta),
      ]);
    } catch (error) {
      if (/CHECK constraint failed/.test(String(error))) throw new ConflictError("Fewer portions than already sold", "CAPACITY_BELOW_USED");
      throw error;
    }
    return this.capacity(actor, date, addDays(date, 1), meta);
  }

  // ================================================================ kitchen orders (spec §24)

  async orders(
    actor: AuthContext,
    f: { from?: string; to?: string; categoryId?: string; status?: string },
    meta: RequestMeta,
  ): Promise<{ from: string; to: string; categories: FoodCategoryRefDto[]; orders: FoodOrderDto[] }> {
    await this.authz.requirePermission(actor, "food_orders.view", meta);
    const { start, end } = this.range(f.from, f.to, await this.today(), 1);
    if (f.categoryId !== undefined && !ID_PATTERN.test(f.categoryId)) throw new ValidationError({ categoryId: "INVALID_FORMAT" });
    if (f.status !== undefined && !(FOOD_ORDER_STATUSES as readonly string[]).includes(f.status)) throw new ValidationError({ status: "INVALID_VALUE" });
    const names = this.authz.can(actor, "bookings.view");
    const [categories, rows] = await Promise.all([
      this.categoryRefs(),
      this.repo.orders({ from: start, to: end, categoryId: f.categoryId ?? null, status: f.status ?? null }),
    ]);
    const lines = await this.repo.lines(rows.map((r) => r.id));
    return {
      from: start,
      to: end,
      categories,
      orders: rows.map((r) => ({
        id: r.id,
        bookingCode: r.booking_code,
        bookingStatus: r.booking_status as BookingStatus,
        paymentStatus: r.payment_status as PaymentStatus,
        customerName: names ? r.customer_name : null,
        itemName: r.item_name,
        categoryId: r.food_category_id,
        categoryCode: r.category_code,
        serviceDate: r.service_date,
        serviceTime: r.service_time,
        status: r.status as FoodOrderStatus,
        totalPersons: r.total_persons,
        kitchenNote: r.kitchen_note,
        updatedAt: r.updated_at,
        lines: lines.filter((l) => l.food_order_id === r.id).map((l) => ({
          name: l.option_name_snapshot, quantity: l.quantity, includedQuantity: l.included_quantity,
          adults: l.adults, children: l.children, pricingType: l.pricing_type_snapshot, cancelled: l.status === "CANCELLED",
        })),
      })),
    };
  }

  async updateOrder(
    actor: AuthContext, id: string, input: { status: FoodOrderStatus; expectedStatus: FoodOrderStatus; kitchenNote?: string | null }, meta: RequestMeta,
  ): Promise<{ id: string; status: FoodOrderStatus; kitchenNote: string | null }> {
    await this.authz.requirePermission(actor, "food_orders.manage", meta);
    const order = ID_PATTERN.test(id) ? await this.repo.order(id) : null;
    if (!order) throw new NotFoundError("Order not found", "RECORD_NOT_FOUND");
    if (order.status !== input.expectedStatus) throw new ConflictError("The order changed meanwhile, please reload", "ORDER_CHANGED");
    if (input.status === "CANCELLED") throw new ConflictError("Cancel the booking to cancel its meals", "ORDER_CANCEL_VIA_BOOKING");
    if (order.status === "CANCELLED") throw new ConflictError("This order is cancelled", "FOOD_ORDER_STATUS_TRANSITION");
    const fromRank = FOOD_ORDER_FLOW.indexOf(order.status as FoodOrderStatus);
    const toRank = FOOD_ORDER_FLOW.indexOf(input.status);
    if (toRank < fromRank) throw new ConflictError("Orders only move forward", "FOOD_ORDER_STATUS_TRANSITION");
    if (toRank > fromRank && !WORKABLE_BOOKING.has(order.booking_status)) {
      throw new ConflictError("The booking is not confirmed yet", "BOOKING_NOT_CONFIRMED");
    }
    const note = input.kitchenNote === undefined ? order.kitchen_note : input.kitchenNote;
    const now = iso(this.clock());
    const results = await this.db.batch([
      this.repo.updateOrderStatement(id, order.status, input.status, note, actor.userId, now),
      this.log.auditStatement(actor.userId, "UPDATE_FOOD_ORDER", "food", id,
        { status: order.status, kitchenNote: order.kitchen_note, bookingCode: order.booking_code },
        { status: input.status, kitchenNote: note }, meta),
    ]);
    if (!(results[0]?.results.length)) throw new ConflictError("The order changed meanwhile, please reload", "ORDER_CHANGED");
    return { id, status: input.status, kitchenNote: note };
  }
}
