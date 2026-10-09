import type {
  AdminBookingDto,
  AdminBookingSummaryDto,
  BookingStatus,
  FoodLineDto,
  NightPriceDto,
  PaymentStatus,
  PublicBookingDto,
  QuoteDto,
} from "../../shared/booking-types.ts";
import { BOOKING_CODE_PATTERN, maskPhone, normalizePhone } from "../../shared/booking-types.ts";
import type { BookingSettingsDto, StayAction } from "../../shared/dashboard-types.ts";
import { todayIn } from "../../shared/dates.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, TooManyRequestsError, ValidationError } from "../http/errors.ts";
import type { BookingRepository, BookingRow } from "../repositories/booking.repository.ts";
import type { PaymentRepository } from "../repositories/payment.repository.ts";
import { publicMediaUrl } from "./media-url.ts";
import { availableChannels, toPaymentDto } from "./payment.service.ts";
import { promptpayPayload } from "../../shared/promptpay.ts";
import { newId } from "../security/tokens.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { PreparedBooking, QuoteInput, QuoteService } from "./quote.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import type { GuestLineDto } from "../../shared/line-types.ts";
import type { OutboxLike } from "./marketing.service.ts";
import type { Attribution, MarketingRepository } from "../repositories/marketing.repository.ts";

export interface CreateBookingInput extends QuoteInput {
  customer: { name: string; phone: string; email: string | null; lineId: string | null; note: string | null };
  expectedTotalSatang: number;
  idempotencyKey: string;
  /** Cookie consent + Meta browser ids at booking time (Phase 14); browser ids only with Marketing consent. */
  attribution?: Attribution | null;
}

/** Abuse limits (security policy, not business configuration). */
export const BOOKING_LIMITS = {
  createPerIpPerHour: 20,
  lookupFailuresPerIp: 10,
  lookupFailuresPerCode: 5,
  lookupWindowMs: 15 * 60_000,
  codeAttempts: 5,
  expiryBatch: 50,
} as const;

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** BK-YYYYMMDD-XXXX, date = today in the property time zone, suffix from a CSPRNG. */
export function generateBookingCode(today: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  // 256 % 36 bias is 4/256 per char — irrelevant for an identifier that also needs the phone to open.
  const suffix = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `BK-${today.replaceAll("-", "")}-${suffix}`;
}

export class BookingService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: BookingRepository,
    private readonly quotes: QuoteService,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly payments: PaymentRepository,
    private readonly mediaBaseUrl: string | undefined,
    /** LINE outbox (Phase 11): kitchen hears about cancelled food orders. */
    private readonly outbox: OutboxLike | null = null,
    /** LINE opt-in state for the guest's booking page (Phase 11). */
    private readonly lineStatus: ((row: BookingRow) => Promise<GuestLineDto>) | null = null,
    /** Marketing attribution + Conversions API Lead (Phase 14). */
    private readonly marketing: MarketingRepository | null = null,
    /** PayPal Checkout can be offered (Cloudflare Secrets present). */
    private readonly paypalReady: boolean = false,
  ) {}

  async quote(input: QuoteInput): Promise<QuoteDto> {
    await this.expireDue();
    return (await this.quotes.prepare(input)).quote;
  }

  // ================================================================ create

  async create(input: CreateBookingInput, meta: RequestMeta): Promise<{ booking: PublicBookingDto; replayed: boolean }> {
    const phoneNormalized = normalizePhone(input.customer.phone);
    if (!phoneNormalized) throw new ValidationError({ "customer.phone": "INVALID_PHONE" });

    // Same idempotency key → same booking (double click / network retry). A different phone means a reused key.
    const replay = await this.replay(input.idempotencyKey, phoneNormalized);
    if (replay) return { booking: replay, replayed: true };

    if (meta.ip) {
      const recent = await this.log.countRecent(["BOOKING_CREATED"], 60 * 60_000, { ip: meta.ip });
      if (recent >= BOOKING_LIMITS.createPerIpPerHour) {
        await this.log.event("BOOKING_RATE_LIMITED", "WARNING", meta);
        throw new TooManyRequestsError(15 * 60);
      }
    }

    await this.expireDue();
    // Never take a booking that cannot be paid.
    if (!(await this.payments.primaryAccount())) {
      throw new ConflictError("Online booking is temporarily unavailable", "PAYMENT_NOT_CONFIGURED");
    }
    const prepared = await this.quotes.prepare(input);
    if (prepared.quote.totalSatang !== input.expectedTotalSatang) {
      throw new HttpError(409, "PRICE_CHANGED", "The price has changed. Please review the new total.", {
        totalSatang: String(prepared.quote.totalSatang),
      });
    }

    const now = this.clock();
    const today = todayIn(await this.quotes.timezone(), now);
    for (let attempt = 0; attempt < BOOKING_LIMITS.codeAttempts; attempt++) {
      const code = generateBookingCode(today);
      const bookingId = newId();
      try {
        // Staff notices (LINE / e-mail) are queued in the same batch: only if the booking really exists.
        const notices = this.outbox?.bookingCreated ? await this.outbox.bookingCreated(bookingId, iso(now)) : [];
        await this.db.batch([...this.createStatements(prepared, input, phoneNormalized, code, bookingId, now, meta), ...notices]);
        const row = await this.repo.findByCode(code);
        return { booking: await this.toPublic(row!), replayed: false };
      } catch (error) {
        const message = String(error);
        if (/UNIQUE constraint failed: bookings\.booking_code/.test(message)) continue;
        if (/UNIQUE constraint failed: bookings\.idempotency_key/.test(message)) {
          const winner = await this.replay(input.idempotencyKey, phoneNormalized);
          if (winner) return { booking: winner, replayed: true };
        }
        throw mapInventoryError(error);
      }
    }
    throw new ConflictError("Could not allocate a booking number, please try again", "BOOKING_CODE_EXHAUSTED");
  }

  private async replay(key: string, phoneNormalized: string): Promise<PublicBookingDto | null> {
    const existing = await this.repo.findByIdempotencyKey(key);
    if (!existing) return null;
    if (!safeEqual(existing.customer_phone_normalized, phoneNormalized)) {
      throw new ConflictError("This request key was already used", "IDEMPOTENCY_KEY_REUSED");
    }
    return this.toPublic(existing);
  }

  private createStatements(p: PreparedBooking, input: CreateBookingInput, phoneNormalized: string, code: string, bookingId: string, now: Date, meta: RequestMeta): D1PreparedStatementLike[] {
    const repo = this.repo;
    const at = iso(now);
    const itemId = newId();
    const q = p.quote;
    const statements: D1PreparedStatementLike[] = [
      repo.insertBookingStatement({
        id: bookingId,
        code,
        lang: input.lang,
        checkIn: q.checkIn,
        checkOut: q.checkOut,
        nights: q.nights,
        adults: q.adults,
        children: q.children,
        name: input.customer.name,
        phone: input.customer.phone,
        phoneNormalized,
        email: input.customer.email,
        lineId: input.customer.lineId,
        note: input.customer.note,
        accommodationSubtotal: q.accommodationSubtotalSatang,
        foodSubtotal: q.foodSubtotalSatang,
        total: q.totalSatang,
        currency: q.currency,
        expiresAt: iso(addMs(now, p.settings.hold_minutes * 60_000)),
        idempotencyKey: input.idempotencyKey,
        privacyAcceptedAt: at,
        now: at,
      }),
      repo.insertItemStatement({
        id: itemId, bookingId, type: q.item.type, unitId: q.item.unitId, quantity: q.item.quantity,
        adults: q.adults, children: q.children, now: at,
      }),
    ];

    // Inventory: the database rejects the whole batch if a night or tent is gone.
    if (p.unit) {
      for (const night of p.nights) statements.push(repo.lockNightStatement(p.unit.id, night, bookingId, itemId, at));
    } else {
      for (const night of p.nights) {
        statements.push(...repo.reserveTentsStatements(night, p.tents, at));
      }
      // Tarp area: its own nightly limit (CHECK) and a price snapshot; triggers re-check camping + option offered.
      if (p.tarp) {
        for (const night of p.nights) statements.push(...repo.reserveTarpStatements(night, p.tarp.quantity, at));
        statements.push(repo.insertTarpStatement({
          id: newId(), bookingId, quantity: p.tarp.quantity, pricePerNight: p.tarp.pricePerNightSatang,
          nights: p.tarp.nights, subtotal: p.tarp.subtotalSatang, now: at,
        }));
      }
    }

    // Immutable price snapshot (spec §17).
    statements.push(repo.insertPriceSnapshotStatement({
      id: newId(),
      bookingId,
      itemId,
      unitId: q.item.unitId,
      name: q.item.name,
      unitType: q.item.type,
      price: q.item.nightly[0]?.priceSatang ?? 0,
      pricingType: q.item.pricingType,
      quantity: q.item.quantity,
      nights: q.nights,
      adults: q.adults,
      children: q.children,
      nightlyJson: JSON.stringify(q.item.nightly),
      subtotal: q.item.subtotalSatang,
      now: at,
    }));

    // Included meals snapshot (spec §20).
    for (const m of p.included) {
      statements.push(repo.insertIncludedMealStatement({
        id: newId(), bookingId, itemId, includedMealId: m.meal.id, categoryId: m.meal.food_category_id,
        optionId: m.option?.id ?? null, name: m.dto.name, persons: m.dto.personsPerNight, nights: q.nights, now: at,
      }));
    }

    // Kitchen orders: one per category × service date; extra portions take daily capacity.
    const orders = new Map<string, { id: string; categoryId: string; date: string; persons: number; reserved: number; defaultMax: number | null }>();
    for (const line of p.foodLines) {
      const key = `${line.category.id}|${line.dto.serviceDate}`;
      const order = orders.get(key) ?? {
        id: newId(), categoryId: line.category.id, date: line.dto.serviceDate, persons: 0, reserved: 0,
        defaultMax: line.category.default_daily_capacity,
      };
      order.persons += line.persons;
      order.reserved += line.capacityQuantity;
      orders.set(key, order);
    }
    for (const o of orders.values()) {
      if (o.reserved > 0 && o.defaultMax !== null) statements.push(...repo.reserveFoodStatements(o.categoryId, o.date, o.reserved, o.defaultMax, at));
      statements.push(repo.insertFoodOrderStatement({ id: o.id, bookingId, categoryId: o.categoryId, date: o.date, persons: o.persons, reserved: o.reserved, now: at }));
    }
    for (const line of p.foodLines) {
      const d = line.dto;
      statements.push(repo.insertFoodItemStatement({
        id: newId(), bookingId, orderId: orders.get(`${line.category.id}|${d.serviceDate}`)!.id, optionId: d.optionId,
        date: d.serviceDate, name: d.name, categoryCode: d.categoryCode, pricingType: d.pricingType, unitPrice: d.unitPriceSatang,
        childPricing: line.option.child_pricing, childPrice: line.childPriceSatang, adults: d.adults, children: d.children,
        quantity: d.quantity, included: d.includedQuantity, subtotal: d.subtotalSatang, now: at,
      }));
    }

    // No PII in logs: booking code and amount only.
    // Payment account snapshot (spec §25): later account changes never touch this booking.
    statements.push(this.payments.insertSnapshotStatement(bookingId, at));

    // Marketing (Phase 14): consent at booking time; Lead queued only with Marketing consent + CAPI on.
    if (this.marketing && input.attribution) {
      statements.push(this.marketing.attributionStatement(bookingId, input.attribution, at), this.marketing.leadStatement(bookingId, at));
    }

    statements.push(this.log.eventStatement("BOOKING_CREATED", "INFO", meta, { identifier: code }));
    statements.push(this.log.auditStatement(null, "CREATE_BOOKING", "bookings", bookingId, null,
      { bookingCode: code, itemType: q.item.type, checkIn: q.checkIn, checkOut: q.checkOut, totalSatang: q.totalSatang }, meta));
    return statements;
  }

  // ================================================================ lookup (Booking ID + phone)

  async lookup(bookingCode: string, phone: string, meta: RequestMeta): Promise<PublicBookingDto> {
    return this.toPublic(await this.guestBooking(bookingCode, phone, meta));
  }

  /**
   * The guest's own booking, proven by Booking ID + phone. Shared by lookup and slip upload,
   * with the same enumeration throttle (failures per code and per IP).
   */
  async guestBooking(bookingCode: string, phone: string, meta: RequestMeta): Promise<BookingRow> {
    const code = bookingCode.trim().toUpperCase();
    const windowMs = BOOKING_LIMITS.lookupWindowMs;
    const [ipFailures, codeFailures] = await Promise.all([
      meta.ip ? this.log.countRecent(["BOOKING_LOOKUP_FAILED"], windowMs, { ip: meta.ip }) : 0,
      BOOKING_CODE_PATTERN.test(code) ? this.log.countRecent(["BOOKING_LOOKUP_FAILED"], windowMs, { identifier: code }) : 0,
    ]);
    if (ipFailures >= BOOKING_LIMITS.lookupFailuresPerIp || codeFailures >= BOOKING_LIMITS.lookupFailuresPerCode) {
      await this.log.event("BOOKING_LOOKUP_THROTTLED", "WARNING", meta, { identifier: BOOKING_CODE_PATTERN.test(code) ? code : null });
      throw new TooManyRequestsError(windowMs / 1000);
    }

    const phoneNormalized = normalizePhone(phone);
    const row = BOOKING_CODE_PATTERN.test(code) ? await this.repo.findByCode(code) : null;
    // One answer for "no such booking" and "wrong phone": no enumeration.
    if (!row || !phoneNormalized || !safeEqual(row.customer_phone_normalized, phoneNormalized)) {
      await this.log.event("BOOKING_LOOKUP_FAILED", "WARNING", meta, { identifier: BOOKING_CODE_PATTERN.test(code) ? code : null });
      throw new NotFoundError("No booking matches this Booking ID and phone number", "BOOKING_NOT_FOUND");
    }
    return this.expireIfDue(row);
  }

  /** Re-reads a booking the guest has already proven access to. */
  async guestBookingById(id: string): Promise<BookingRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundError("Booking not found", "BOOKING_NOT_FOUND");
    return row;
  }

  /** Public view of a booking row (from snapshots). */
  publicView(row: BookingRow): Promise<PublicBookingDto> {
    return this.toPublic(row);
  }

  // ================================================================ expiry (cron + opportunistic)

  /** Expires unpaid holds past their deadline and releases their inventory. Returns how many expired. */
  async expireDue(limit: number = BOOKING_LIMITS.expiryBatch): Promise<number> {
    const now = iso(this.clock());
    const due = await this.repo.dueForExpiry(now, limit);
    let expired = 0;
    for (const b of due) {
      try {
        if (await this.expireOne(b.id, b.booking_code, b.check_in, b.check_out, now)) expired++;
      } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "booking_expiry_failed", bookingCode: b.booking_code, error: String(error) }));
      }
    }
    return expired;
  }

  private async expireIfDue(row: BookingRow): Promise<BookingRow> {
    const now = iso(this.clock());
    if (row.booking_status === "PENDING" && (row.payment_status === "UNPAID" || row.payment_status === "REJECTED") && row.expires_at && row.expires_at <= now) {
      await this.expireOne(row.id, row.booking_code, row.check_in, row.check_out, now);
      return (await this.repo.findByCode(row.booking_code)) ?? row;
    }
    return row;
  }

  private async expireOne(id: string, code: string, checkIn: string, checkOut: string, now: string): Promise<boolean> {
    const results = await this.db.batch([
      this.repo.expireStatement(id, now),
      ...this.repo.releaseStatements(id, checkIn, checkOut, now),
    ]);
    const changed = (results[0]?.results.length ?? 0) > 0;
    if (changed) {
      await this.log.event("BOOKING_EXPIRED", "INFO", { ip: null, userAgent: null }, { identifier: code });
    }
    return changed;
  }

  // ================================================================ admin

  async adminList(
    actor: AuthContext,
    filter: { status?: BookingStatus; payment?: PaymentStatus; from?: string; to?: string; q?: string; before?: string; limit: number },
    meta: RequestMeta,
  ): Promise<{ items: AdminBookingSummaryDto[]; nextCursor: string | null }> {
    await this.authz.requirePermission(actor, "bookings.view", meta);
    const q = filter.q?.trim();
    const rows = await this.repo.list({
      ...filter,
      q: q ? q.toUpperCase().startsWith("BK-") ? q.toUpperCase() : q : undefined,
      qPhone: q ? normalizePhone(q) : null,
      limit: filter.limit + 1,
    });
    const page = rows.slice(0, filter.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        bookingCode: r.booking_code,
        status: r.booking_status as BookingStatus,
        paymentStatus: r.payment_status as PaymentStatus,
        checkIn: r.check_in,
        checkOut: r.check_out,
        nights: r.nights,
        adults: r.adults,
        children: r.children,
        itemType: r.item_type,
        itemName: r.item_name,
        quantity: r.quantity,
        tarps: r.tarps,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        totalSatang: r.total_satang,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      })),
      nextCursor: rows.length > filter.limit ? page[page.length - 1]!.created_at : null,
    };
  }

  async adminGet(actor: AuthContext, code: string, meta: RequestMeta): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "bookings.view", meta);
    const row = await this.findOr404(code);
    return this.toAdmin(await this.expireIfDue(row));
  }

  async adminCancel(actor: AuthContext, code: string, reason: string, meta: RequestMeta): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "bookings.cancel", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    if (row.booking_status !== "PENDING" && row.booking_status !== "CONFIRMED") {
      throw new ConflictError("Only pending or confirmed bookings can be cancelled", "BOOKING_NOT_CANCELLABLE");
    }
    const now = iso(this.clock());
    const results = await this.db.batch(await this.cancelStatements(row, actor.userId, reason, now));
    if (!(results[0]?.results.length)) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_NOT_CANCELLABLE");
    await this.log.auditStatement(actor.userId, "CANCEL_BOOKING", "bookings", row.id,
      { status: row.booking_status, paymentStatus: row.payment_status }, { status: "CANCELLED", reason }, meta).run();
    return this.toAdmin((await this.repo.findByCode(row.booking_code))!);
  }

  /**
   * Cancels a PENDING / CONFIRMED booking and gives back what it held; the guest (LINE / e-mail) and the
   * kitchen are told in the same batch. The first statement RETURNs the id when the cancel happened.
   */
  async cancelStatements(row: BookingRow, actorId: string, reason: string, now: string): Promise<D1PreparedStatementLike[]> {
    return [
      this.repo.cancelStatement(row.id, actorId, reason, now),
      ...this.repo.releaseStatements(row.id, row.check_in, row.check_out, now),
      ...(this.outbox ? await this.outbox.bookingCancelled(row.id, row.booking_status === "CONFIRMED", now) : []),
    ];
  }

  /**
   * Stay lifecycle (spec §13): check-in (CONFIRMED, from the check-in date), check-out (CHECKED_IN),
   * no-show (CONFIRMED, from the check-in date). Nights stay reserved — the stay was sold.
   * The DB trigger trg_bookings_status_transition rejects any other move.
   */
  async adminStay(actor: AuthContext, code: string, action: StayAction, meta: RequestMeta): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "bookings.edit", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    const today = todayIn(await this.quotes.timezone(), this.clock());
    const plan = {
      "check-in": { from: "CONFIRMED", to: "CHECKED_IN", audit: "CHECK_IN" },
      "check-out": { from: "CHECKED_IN", to: "CHECKED_OUT", audit: "CHECK_OUT" },
      "no-show": { from: "CONFIRMED", to: "NO_SHOW", audit: "NO_SHOW" },
    }[action];
    if (row.booking_status !== plan.from) {
      throw new ConflictError(`Booking must be ${plan.from} for this action`, "BOOKING_STATUS_INVALID");
    }
    if ((action === "check-in" || action === "no-show") && today < row.check_in) {
      throw new ConflictError("The stay has not started yet", "STAY_NOT_STARTED");
    }
    if (action === "check-in" && today >= row.check_out) {
      throw new ConflictError("The stay has already ended", "STAY_ENDED");
    }
    const now = iso(this.clock());
    const results = await this.db.batch([
      this.repo.transitionStatement(row.id, plan.from, plan.to, now),
      this.log.auditStatement(actor.userId, plan.audit, "bookings", row.id, { status: plan.from }, { status: plan.to }, meta),
    ]);
    if (!(results[0]?.results.length)) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_STATUS_INVALID");
    return this.toAdmin((await this.repo.findByCode(row.booking_code))!);
  }

  async getSettings(actor: AuthContext, meta: RequestMeta): Promise<BookingSettingsDto> {
    if (!this.authz.can(actor, "bookings.view")) await this.authz.requirePermission(actor, "settings.website", meta);
    const s = await this.repo.settings();
    return {
      holdMinutes: s?.hold_minutes ?? 60,
      maxNights: s?.max_nights ?? 30,
      maxAdvanceDays: s?.max_advance_days ?? 365,
      maxTentsPerBooking: s?.max_tents_per_booking ?? 10,
      updatedAt: s?.updated_at ?? null,
    };
  }

  /** Changes apply to new bookings only; existing holds keep their deadline. */
  async saveSettings(
    actor: AuthContext,
    input: { holdMinutes: number; maxNights: number; maxAdvanceDays: number; maxTentsPerBooking: number },
    meta: RequestMeta,
  ): Promise<BookingSettingsDto> {
    await this.authz.requirePermission(actor, "settings.website", meta);
    const before = await this.getSettings(actor, meta);
    await this.db.batch([
      this.repo.saveSettingsStatement(input, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "UPDATE_BOOKING_SETTINGS", "settings", "booking_settings",
        { ...before, updatedAt: undefined }, input, meta),
    ]);
    return this.getSettings(actor, meta);
  }

  private async findOr404(code: string): Promise<BookingRow> {
    const row = BOOKING_CODE_PATTERN.test(code) ? await this.repo.findByCode(code) : null;
    if (!row) throw new NotFoundError("Booking not found", "BOOKING_NOT_FOUND");
    return row;
  }

  // ================================================================ DTOs (from snapshots, never from current prices)

  private async toPublic(row: BookingRow): Promise<PublicBookingDto> {
    // Payment details only while the booking is still waiting for money.
    const awaitingPayment = row.booking_status === "PENDING" && (row.payment_status === "UNPAID" || row.payment_status === "REJECTED");
    const [items, included, food, snapshot, lineUpdates, tarp, paySettings, payments] = await Promise.all([
      this.repo.items(row.id),
      this.repo.includedMeals(row.id),
      this.repo.food(row.id),
      this.payments.snapshot(row.id),
      this.lineStatus ? this.lineStatus(row) : Promise.resolve({ available: false, linked: false }),
      this.repo.tarp(row.id),
      awaitingPayment ? this.payments.settings() : Promise.resolve(null),
      awaitingPayment && row.payment_status === "REJECTED" ? this.payments.payments(row.id) : Promise.resolve([]),
    ]);
    const rejected = payments.filter((p) => p.status === "REJECTED").at(-1);
    const item = items[0]!;
    return {
      bookingCode: row.booking_code,
      status: row.booking_status as BookingStatus,
      paymentStatus: row.payment_status as PaymentStatus,
      customerName: row.customer_name,
      customerPhoneMasked: maskPhone(row.customer_phone),
      expiresAt: row.booking_status === "PENDING" ? row.expires_at : null,
      createdAt: row.created_at,
      lineUpdates,
      paymentInstructions: awaitingPayment && snapshot && paySettings ? {
        bankName: snapshot.bank_name_snapshot,
        accountName: snapshot.account_name_snapshot,
        accountNumber: snapshot.account_number_snapshot,
        promptpayNumber: snapshot.promptpay_number_snapshot,
        qrUrl: publicMediaUrl(snapshot.payment_qr_snapshot, this.mediaBaseUrl),
        amountDueSatang: row.total_satang,
        channels: availableChannels(paySettings, {
          promptpay: snapshot.promptpay_number_snapshot, accountNumber: snapshot.account_number_snapshot, qr: snapshot.payment_qr_snapshot,
        }, this.paypalReady),
        promptpayPayload: snapshot.promptpay_number_snapshot && row.total_satang > 0 ? promptpayPayload(snapshot.promptpay_number_snapshot, row.total_satang) : null,
      } : null,
      paymentRejectedReason: rejected?.rejected_reason ?? null,
      cancelReason: row.booking_status === "CANCELLED" ? row.cancel_reason : null,
      checkIn: row.check_in,
      checkOut: row.check_out,
      nights: row.nights,
      adults: row.adults,
      children: row.children,
      item: {
        type: item.item_type,
        unitId: item.unit_id,
        slug: item.slug,
        name: item.unit_name_snapshot,
        quantity: item.quantity,
        pricingType: item.pricing_type,
        nightly: item.nightly_prices_json ? (JSON.parse(item.nightly_prices_json) as NightPriceDto[]) : [],
        subtotalSatang: item.snapshot_subtotal_satang,
      },
      tarp: tarp ? {
        quantity: tarp.quantity, pricePerNightSatang: tarp.price_per_night_satang, nights: tarp.number_of_nights, subtotalSatang: tarp.subtotal_satang,
      } : null,
      includedMeals: included.map((m) => ({
        categoryCode: m.category_code, name: m.meal_name_snapshot, personsPerNight: m.persons_per_night_snapshot, nights: m.number_of_nights,
      })),
      food: food.map((f): FoodLineDto => ({
        optionId: f.food_option_id,
        categoryCode: f.category_code_snapshot,
        name: f.option_name_snapshot,
        serviceDate: f.service_date,
        pricingType: f.pricing_type_snapshot,
        adults: f.adults,
        children: f.children,
        quantity: f.quantity,
        includedQuantity: f.included_quantity,
        unitPriceSatang: f.unit_price_snapshot_satang,
        subtotalSatang: f.subtotal_satang,
      })),
      accommodationSubtotalSatang: row.accommodation_subtotal_satang,
      foodSubtotalSatang: row.food_subtotal_satang,
      discountSatang: row.discount_satang,
      totalSatang: row.total_satang,
      currency: row.currency,
    };
  }

  private async toAdmin(row: BookingRow): Promise<AdminBookingDto> {
    const [snapshot, payments] = await Promise.all([this.payments.snapshot(row.id), this.payments.payments(row.id)]);
    return {
      ...(await this.toPublic(row)),
      paymentAccount: snapshot ? {
        receivingAccountId: snapshot.receiving_account_id,
        bankName: snapshot.bank_name_snapshot,
        accountName: snapshot.account_name_snapshot,
        accountNumber: snapshot.account_number_snapshot,
        promptpayNumber: snapshot.promptpay_number_snapshot,
        qrUrl: publicMediaUrl(snapshot.payment_qr_snapshot, this.mediaBaseUrl),
        capturedAt: snapshot.captured_at,
      } : null,
      payments: payments.map(toPaymentDto),
      expiresAt: row.expires_at,
      id: row.id,
      source: row.source,
      languageCode: row.language_code,
      customerPhone: row.customer_phone,
      customerEmail: row.customer_email,
      customerLineId: row.customer_line_id,
      customerNote: row.customer_note,
      privacyAcceptedAt: row.privacy_accepted_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      updatedAt: row.updated_at,
    };
  }
}

/** Maps database constraint failures from the booking batch to business errors. */
export function mapInventoryError(error: unknown): unknown {
  const message = String(error);
  if (/UNIQUE constraint failed: booking_unit_nights/.test(message)) {
    return new ConflictError("This accommodation was just booked by someone else", "UNIT_UNAVAILABLE");
  }
  if (/CHECK constraint failed: .*tents_used/.test(message)) {
    return new ConflictError("Not enough camping space for these nights", "CAMPING_FULL");
  }
  if (/CHECK constraint failed: .*tarps_used/.test(message)) {
    return new ConflictError("No tarp area left for these nights", "TARP_FULL");
  }
  if (/TARP_DISABLED/.test(message)) {
    return new ConflictError("The tarp area option is not offered", "TARP_UNAVAILABLE");
  }
  if (/NOT NULL constraint failed: payment_account_snapshots/.test(message)) {
    return new ConflictError("Online booking is temporarily unavailable", "PAYMENT_NOT_CONFIGURED");
  }
  if (/CAMPING_DISABLED/.test(message)) {
    return new NotFoundError("Camping is not available", "CAMPING_UNAVAILABLE");
  }
  if (/UNIT_NOT_BOOKABLE/.test(message)) {
    return new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
  }
  if (/CHECK constraint failed: .*used_quantity/.test(message)) {
    return new ConflictError("Not enough portions left for this meal", "FOOD_CAPACITY_EXCEEDED");
  }
  return error;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
