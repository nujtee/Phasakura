import type {
  ChannexAutoCreateDto, ChannexPropertiesDto, ChannexRoomsDto, ChannexStatusDto, ChannexUnitDto,
} from "../../shared/channel-types.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";
import { ChannexError, type ChannexApi, type ChannexEnvironment } from "../channex/channex-api.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { ChannelRepository, ChannexAriStateRow, ChannexUnitMapRow } from "../repositories/channel.repository.ts";
import type { InventoryRepository } from "../repositories/inventory.repository.ts";
import type { PricingRepository } from "../repositories/pricing.repository.ts";
import { addDays, stayNights } from "../../shared/dates.ts";
import { nightPrice } from "./quote.service.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Channex wants a full resend every night. */
const FULL_PUSH_EVERY_MS = 24 * 3_600_000;
/** Nights sent ahead (bounded by how far guests can book). */
const ARI_MAX_DAYS = 500;
const STATE_CHUNK = 400;

/** What the price / availability push needs from the rest of the site. */
export interface AriDeps {
  inventory: Pick<InventoryRepository, "nightLocks">;
  pricing: Pick<PricingRepository, "activeRules">;
  today: () => Promise<string>;
  maxAdvanceDays: () => Promise<number>;
}

/**
 * Channex connection (phase O2, migration 0034). This site is one Channex property; each house / VIP tent is one
 * Channex room type (a single unit) with one rate plan. Availability / prices (O3) and OTA bookings (O4) come later.
 *
 *  - The key is a Cloudflare Secret (CHANNEX_API_KEY); CHANNEX_ENV picks staging (default) or production.
 *  - Choosing the property: SUPER_ADMIN or MANAGER (channels.edit); changing it drops every unit's mapping.
 *  - Mapping units (by hand, or "create them in Channex") is channels.edit.
 *  - Nothing here works while Channex is switched off (channel_settings.channex_enabled).
 */
export class ChannexService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: ChannelRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly api: ChannexApi | null,
    readonly environment: ChannexEnvironment,
    private readonly ari: AriDeps | null = null,
  ) {}

  get configured(): boolean {
    return this.api !== null;
  }

  async status(enabled: boolean): Promise<ChannexStatusDto> {
    const settings = await this.repo.channexSettings();
    const units: ChannexUnitDto[] = [];
    if (settings) {
      const [rows, names, map] = await Promise.all([this.repo.channexUnits(), this.repo.units(), this.repo.channexMap()]);
      const byUnit = new Map(map.map((m) => [m.unit_id, m]));
      for (const u of rows) {
        const m = byUnit.get(u.id);
        units.push({
          unitId: u.id, unitCode: u.unit_code, unitType: u.unit_type, names: namesOf(names, u.id),
          roomTypeId: m?.room_type_id ?? null, roomTypeTitle: m?.room_type_title ?? null,
          ratePlanId: m?.rate_plan_id ?? null, ratePlanTitle: m?.rate_plan_title ?? null,
        });
      }
    }
    // A property chosen on the other Channex environment does not count (staging and production are separate accounts).
    const sameEnv = settings?.property_id && (settings.environment ?? "staging") === this.environment;
    const ari = await this.repo.channexAri();
    return {
      ari: {
        supported: ari !== null,
        enabled: ari?.ari_enabled === 1,
        markupPercent: ari?.rate_markup_percent ?? 0,
        lastPushAt: ari?.last_push_at ?? null,
        lastPushStatus: ari?.last_push_status ?? null,
        lastPushError: ari?.last_push_error ?? null,
        lastPushChanges: ari?.last_push_changes ?? null,
        lastFullPushAt: ari?.last_full_push_at ?? null,
        // OTA bookings come in (phase O4): the live account may send.
        liveBlocked: false,
      },
      enabled,
      available: this.configured,
      environment: this.environment,
      property: sameEnv ? { id: settings!.property_id!, title: settings!.property_title, currency: settings!.currency } : null,
      lastCheckAt: settings?.last_check_at ?? null,
      lastCheckStatus: settings?.last_check_status ?? null,
      lastCheckError: settings?.last_check_error ?? null,
      units: sameEnv ? units : units.map((u) => ({ ...u, roomTypeId: null, roomTypeTitle: null, ratePlanId: null, ratePlanTitle: null })),
    };
  }

  /** channels.edit: can this key reach Channex? Lists the properties it sees. */
  async testConnection(actor: AuthContext, meta: RequestMeta): Promise<ChannexPropertiesDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    const api = await this.ready();
    const now = iso(this.clock());
    try {
      const properties = await api.properties();
      await this.repo.channexCheckStatement("OK", null, now).run();
      return { properties };
    } catch (error) {
      await this.repo.channexCheckStatement("ERROR", errorText(error), now).run();
      throw toHttp(error);
    }
  }

  /** channels.edit (SUPER_ADMIN, MANAGER): which Channex property this site is (null = none). A change drops the mapping. */
  async selectProperty(actor: AuthContext, propertyId: string | null, meta: RequestMeta): Promise<ChannexStatusDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    const api = await this.ready();
    if (propertyId !== null && !UUID.test(propertyId)) throw new ValidationError({ propertyId: "INVALID_ID" });
    const before = await this.repo.channexSettings();
    const now = iso(this.clock());
    let chosen: { id: string | null; title: string | null; currency: string | null } = { id: null, title: null, currency: null };
    if (propertyId) {
      try {
        const p = await api.property(propertyId);
        chosen = { id: p.id, title: p.title.slice(0, 255), currency: p.currency && /^[A-Z]{3}$/.test(p.currency) ? p.currency : null };
      } catch (error) {
        throw toHttp(error);
      }
    }
    const changed = chosen.id !== before?.property_id || (before?.environment ?? "staging") !== this.environment;
    await this.db.batch([
      this.repo.channexPropertyStatement({ ...chosen, environment: chosen.id ? this.environment : null }, actor.userId, now),
      ...(changed ? [this.repo.clearUnitMapStatement(), this.repo.clearAriStateStatement()] : []),
      this.log.auditStatement(actor.userId, "CHANNEX_PROPERTY_SET", "channels", "channex",
        { propertyId: before?.property_id ?? null, title: before?.property_title ?? null, environment: before?.environment ?? null },
        { propertyId: chosen.id, title: chosen.title, environment: this.environment, mappingCleared: changed }, meta),
    ]);
    return this.status(true);
  }

  /** channels.edit: the room types and rate plans of the chosen property. */
  async rooms(actor: AuthContext, meta: RequestMeta): Promise<ChannexRoomsDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    const { api, propertyId } = await this.withProperty();
    try {
      const [roomTypes, ratePlans] = await Promise.all([api.roomTypes(propertyId), api.ratePlans(propertyId)]);
      return {
        roomTypes: roomTypes.map((r) => ({ id: r.id, title: r.title, occAdults: r.occAdults })),
        ratePlans: ratePlans.map((r) => ({ id: r.id, title: r.title, roomTypeId: r.roomTypeId, currency: r.currency, occupancy: r.occupancy })),
      };
    } catch (error) {
      throw toHttp(error);
    }
  }

  /** channels.edit: one unit ↔ a Channex room type (+ rate plan of that room type); roomTypeId null = unmap. */
  async mapUnit(actor: AuthContext, unitId: string, roomTypeId: string | null, ratePlanId: string | null, meta: RequestMeta): Promise<ChannexStatusDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    const { api, propertyId } = await this.withProperty();
    if (!(await this.repo.channexUnits()).some((u) => u.id === unitId)) throw new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
    const now = iso(this.clock());
    const before = (await this.repo.channexMap()).find((m) => m.unit_id === unitId) ?? null;
    if (roomTypeId === null) {
      await this.db.batch([
        this.repo.deleteUnitMapStatement(unitId),
        this.repo.clearAriStateStatement(unitId),
        this.log.auditStatement(actor.userId, "CHANNEX_UNIT_UNMAPPED", "channels", unitId, before, null, meta),
      ]);
      return this.status(true);
    }
    let roomTypes; let ratePlans;
    try {
      [roomTypes, ratePlans] = await Promise.all([api.roomTypes(propertyId), api.ratePlans(propertyId)]);
    } catch (error) {
      throw toHttp(error);
    }
    const room = roomTypes.find((r) => r.id === roomTypeId);
    if (!room) throw new ValidationError({ roomTypeId: "NOT_IN_PROPERTY" });
    const rate = ratePlanId === null ? null : ratePlans.find((r) => r.id === ratePlanId);
    if (ratePlanId !== null && (!rate || rate.roomTypeId !== roomTypeId)) throw new ValidationError({ ratePlanId: "NOT_OF_ROOM_TYPE" });
    const taken = (await this.repo.channexMap()).find((m) => m.unit_id !== unitId && (m.room_type_id === roomTypeId || (ratePlanId && m.rate_plan_id === ratePlanId)));
    if (taken) throw new ConflictError("This Channex room type is already used by another unit", "CHANNEX_ROOM_TAKEN");
    const row: ChannexUnitMapRow = {
      unit_id: unitId, room_type_id: room.id, room_type_title: room.title.slice(0, 255),
      rate_plan_id: rate?.id ?? null, rate_plan_title: rate?.title.slice(0, 255) ?? null,
    };
    await this.db.batch([
      this.repo.setUnitMapStatement(row, actor.userId, now),
      this.repo.clearAriStateStatement(unitId),
      this.log.auditStatement(actor.userId, "CHANNEX_UNIT_MAPPED", "channels", unitId, before, row, meta),
    ]);
    return this.status(true);
  }

  /**
   * channels.edit: for every house / VIP tent without a room type, create one in Channex (a single unit) with a
   * "Standard" per-room rate plan at the unit's base price. Units already mapped are left alone; a failure on one
   * unit does not undo the others (what was created stays mapped).
   */
  async autoCreate(actor: AuthContext, meta: RequestMeta): Promise<ChannexAutoCreateDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    const { api, propertyId, currency } = await this.withProperty();
    const [units, names, map] = await Promise.all([this.repo.channexUnits(), this.repo.units(), this.repo.channexMap()]);
    const mapped = new Set(map.map((m) => m.unit_id));
    const created: ChannexAutoCreateDto["created"] = [];
    const failed: ChannexAutoCreateDto["failed"] = [];
    let existingTitles: Set<string>;
    try {
      existingTitles = new Set((await api.roomTypes(propertyId)).map((r) => r.title.toLowerCase()));
    } catch (error) {
      throw toHttp(error);
    }
    for (const u of units.filter((x) => !mapped.has(x.id))) {
      const name = namesOf(names, u.id).th ?? namesOf(names, u.id).en;
      let title = name ? `${u.unit_code} · ${name}` : u.unit_code;
      if (existingTitles.has(title.toLowerCase())) title = `${title} (${u.id.slice(0, 6)})`;
      const adults = Math.max(1, u.max_adults ?? u.max_guests);
      try {
        const room = await api.createRoomType({ propertyId, title: title.slice(0, 255), adults, children: Math.max(0, u.max_guests - adults) });
        existingTitles.add(room.title.toLowerCase());
        let rate: { id: string; title: string } | null = null;
        let rateError: string | null = null;
        try {
          rate = await api.createRatePlan({
            propertyId, roomTypeId: room.id, title: "Standard", currency: currency ?? "THB", occupancy: adults,
            rate: (u.base_price_satang / 100).toFixed(2),
          });
        } catch (error) {
          rateError = errorText(error);
        }
        const row: ChannexUnitMapRow = { unit_id: u.id, room_type_id: room.id, room_type_title: room.title, rate_plan_id: rate?.id ?? null, rate_plan_title: rate?.title ?? null };
        await this.db.batch([
          this.repo.setUnitMapStatement(row, actor.userId, iso(this.clock())),
          this.repo.clearAriStateStatement(u.id),
          this.log.auditStatement(actor.userId, "CHANNEX_UNIT_CREATED", "channels", u.id, null, row, meta),
        ]);
        created.push({ unitId: u.id, roomTypeId: room.id, ratePlanId: rate?.id ?? null });
        if (rateError) failed.push({ unitId: u.id, error: `RATE_PLAN: ${rateError}` });
      } catch (error) {
        failed.push({ unitId: u.id, error: errorText(error) });
        if (error instanceof ChannexError && (error.code === "CHANNEX_KEY_INVALID" || error.code === "CHANNEX_RATE_LIMITED" || error.code === "CHANNEX_UNREACHABLE")) break;
      }
    }
    return { created, failed, status: await this.status(true) };
  }

  // ---------------------------------------------------------------- availability and prices (phase O3)

  /**
   * channels.edit: start / stop sending, and the OTA price markup. Sending is refused on the live Channex account
   * until OTA bookings come back into this site (phase O4): Channex closes a sold night by itself, but the nightly full
   * resend would open it again while the booking is not here yet.
   */
  async setAri(actor: AuthContext, change: { enabled?: boolean; markupPercent?: number }, meta: RequestMeta): Promise<ChannexStatusDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    await this.withProperty();
    const before = await this.repo.channexAri();
    if (!before) throw new ConflictError("Run the database migrations first", "SCHEMA_OUTDATED");
    const enabled = change.enabled ?? before.ari_enabled === 1;
    const markup = change.markupPercent ?? before.rate_markup_percent;
    if (!Number.isInteger(markup) || markup < 0 || markup > 100) throw new ValidationError({ markupPercent: "OUT_OF_RANGE" });
    if (enabled && !(await this.repo.channexMap()).length) throw new ConflictError("Map at least one unit first", "CHANNEX_NO_ROOMS");
    await this.db.batch([
      this.repo.setAriStatement(enabled, markup, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "CHANNEX_ARI_SET", "channels", "channex",
        { enabled: before.ari_enabled === 1, markupPercent: before.rate_markup_percent }, { enabled, markupPercent: markup }, meta),
    ]);
    // Starting sends everything at once; a new markup sends the prices that changed.
    if (enabled) await this.push(before.ari_enabled !== 1);
    return this.status(true);
  }

  /** channels.edit: send every night again now. */
  async pushNow(actor: AuthContext, meta: RequestMeta): Promise<ChannexStatusDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    await this.withProperty();
    const ari = await this.repo.channexAri();
    if (ari?.ari_enabled !== 1) throw new ConflictError("Sending is not started", "CHANNEX_ARI_OFF");
    await this.push(true);
    await this.log.auditStatement(actor.userId, "CHANNEX_ARI_PUSH", "channels", "channex", null, { full: true }, meta).run();
    return this.status(true);
  }

  /** Cron, every minute: send what changed; everything once a day. */
  async tick(): Promise<{ sent: number; status: string } | null> {
    if (!this.api || !this.ari) return null;
    if ((await this.repo.settings())?.channex_enabled !== 1) return null;
    const ari = await this.repo.channexAri();
    if (ari?.ari_enabled !== 1) return null;
    const now = this.clock();
    if (ari.retry_after && ari.retry_after > iso(now)) return null;
    const full = !ari.last_full_push_at || now.getTime() - new Date(ari.last_full_push_at).getTime() >= FULL_PUSH_EVERY_MS;
    return this.push(full);
  }

  /** Works out every mapped unit's availability and price per night and sends what Channex does not have yet. */
  private async push(full: boolean): Promise<{ sent: number; status: string }> {
    const api = this.api!;
    const deps = this.ari!;
    const s = await this.repo.channexSettings();
    const ari = await this.repo.channexAri();
    if (!s?.property_id || !ari) return { sent: 0, status: "SKIPPED" };
    const propertyId = s.property_id;
    const now = iso(this.clock());
    const today = await deps.today();
    const days = Math.min(ARI_MAX_DAYS, (await deps.maxAdvanceDays()) + 1);
    const until = addDays(today, days);
    const [units, map, locks, known] = await Promise.all([
      this.repo.channexUnits(), this.repo.channexMap(), deps.inventory.nightLocks(today, until), full ? Promise.resolve([]) : this.repo.ariState(today),
    ]);
    const locked = new Set(locks.map((l) => `${l.unit_id}|${l.stay_date}`));
    const before = new Map(known.map((k) => [`${k.unit_id}|${k.stay_date}`, k]));
    const nights = stayNights(today, until);
    const want: ChannexAriStateRow[] = [];
    const availability: { property_id: string; room_type_id: string; date: string; availability: number }[] = [];
    const rates: { property_id: string; rate_plan_id: string; date: string; rate: string }[] = [];
    for (const m of map) {
      const unit = units.find((u) => u.id === m.unit_id);
      if (!unit) continue;
      const rules = m.rate_plan_id ? await deps.pricing.activeRules({ unitId: unit.id, unitType: unit.unit_type }, today, addDays(until, -1)) : [];
      for (const date of nights) {
        const avail = unit.status === "ACTIVE" && !locked.has(`${unit.id}|${date}`) ? 1 : 0;
        const rate = m.rate_plan_id ? Math.round((nightPrice(rules, date, unit.base_price_satang) * (100 + ari.rate_markup_percent)) / 100) : null;
        const old = before.get(`${unit.id}|${date}`);
        const row = { unit_id: unit.id, stay_date: date, availability: avail, rate_satang: rate };
        let changed = false;
        if (!old || old.availability !== avail) { availability.push({ property_id: propertyId, room_type_id: m.room_type_id, date, availability: avail }); changed = true; }
        // Channex refuses a 0 rate; a free night is simply not priced.
        if (m.rate_plan_id && rate !== null && rate > 0 && (!old || old.rate_satang !== rate)) {
          rates.push({ property_id: propertyId, rate_plan_id: m.rate_plan_id, date, rate: (rate / 100).toFixed(2) });
          changed = true;
        }
        if (changed) want.push(row);
      }
    }
    if (!availability.length && !rates.length) {
      await this.repo.pushResultStatement({ status: "OK", error: null, changes: 0, full, retryAfter: null }, now).run();
      return { sent: 0, status: "OK" };
    }
    const warnings: string[] = [];
    try {
      // Availability first: Channex handles it first, and a closed night matters more than its price.
      if (availability.length) warnings.push(...(await api.pushAvailability(availability)).warnings);
      if (rates.length) warnings.push(...(await api.pushRestrictions(rates)).warnings);
    } catch (error) {
      const limited = error instanceof ChannexError && error.code === "CHANNEX_RATE_LIMITED";
      await this.repo.pushResultStatement({
        status: "ERROR", error: errorText(error), changes: null, full,
        retryAfter: iso(new Date(this.clock().getTime() + (limited ? 60_000 : 0))),
      }, now).run();
      return { sent: 0, status: "ERROR" };
    }
    const statements = [];
    for (let i = 0; i < want.length; i += STATE_CHUNK) statements.push(this.repo.saveAriStateStatement(want.slice(i, i + STATE_CHUNK), now));
    statements.push(this.repo.pruneAriStateStatement(today));
    statements.push(this.repo.pushResultStatement({
      status: warnings.length ? "WARNING" : "OK", error: warnings.length ? `${warnings.length} refused: ${warnings.slice(0, 2).join(" · ")}` : null,
      changes: availability.length + rates.length, full, retryAfter: null,
    }, now));
    await this.db.batch(statements);
    return { sent: availability.length + rates.length, status: warnings.length ? "WARNING" : "OK" };
  }

  // ---------------------------------------------------------------- helpers

  private async ready(): Promise<ChannexApi> {
    if (!this.api) throw new ConflictError("Set the CHANNEX_API_KEY secret on this site first", "CHANNEX_NOT_CONFIGURED");
    if ((await this.repo.settings())?.channex_enabled !== 1) throw new ConflictError("Channex is switched off", "CHANNEX_DISABLED");
    if (!(await this.repo.channexSettings())) throw new ConflictError("Run the database migrations first", "SCHEMA_OUTDATED");
    return this.api;
  }

  private async withProperty(): Promise<{ api: ChannexApi; propertyId: string; currency: string | null }> {
    const api = await this.ready();
    const s = await this.repo.channexSettings();
    if (!s?.property_id || (s.environment ?? "staging") !== this.environment) {
      throw new ConflictError("Choose the Channex property first", "CHANNEX_NO_PROPERTY");
    }
    return { api, propertyId: s.property_id, currency: s.currency };
  }
}

function namesOf(rows: { id: string; language_code: string | null; name: string | null }[], unitId: string): Partial<Record<LocaleCode, string>> {
  const out: Partial<Record<LocaleCode, string>> = {};
  for (const r of rows) if (r.id === unitId && r.language_code && r.name) out[r.language_code as LocaleCode] = r.name;
  return out;
}

function errorText(error: unknown): string {
  if (error instanceof ChannexError) return `${error.code}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}

/** Channex problems as API errors the admin page explains (502: the problem is on Channex's side or the key). */
function toHttp(error: unknown): unknown {
  if (!(error instanceof ChannexError)) return error;
  const status = error.code === "CHANNEX_KEY_INVALID" ? 502 : error.code === "CHANNEX_RATE_LIMITED" ? 429 : error.code === "CHANNEX_NOT_FOUND" ? 404 : 502;
  return new HttpError(status, error.code, error.message.slice(0, 300));
}
