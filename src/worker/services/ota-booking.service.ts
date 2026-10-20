import type { OtaBookingDto, OtaBookingsDto } from "../../shared/channel-types.ts";
import { normalizePhone } from "../../shared/booking-types.ts";
import { diffDays, isIsoDate, stayNights } from "../../shared/dates.ts";
import { ChannexError, type ChannexApi, type ChannexRevision } from "../channex/channex-api.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { NotFoundError } from "../http/errors.ts";
import type { BookingRepository } from "../repositories/booking.repository.ts";
import type { ChannelRepository } from "../repositories/channel.repository.ts";
import type { OtaBookingRepository, OtaBookingRow, OtaBookingStatus } from "../repositories/ota-booking.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { generateBookingCode } from "./booking.service.ts";
/** Staff LINE only: no Meta Purchase event and no e-mail to the OTA guest (the OTA talks to its guest). */
export interface OtaOutbox {
  bookingCreated(bookingId: string, now: string): Promise<D1PreparedStatementLike[]>;
  bookingCancelled(bookingId: string, wasConfirmed: boolean, now: string): Promise<D1PreparedStatementLike[]>;
}
import type { SecurityLogService } from "./security-log.service.ts";

/** Revisions handled per cron run (oldest first; the rest next minute). */
const REVISIONS_PER_TICK = 25;
const SYSTEM = { ip: null, userAgent: null };

/**
 * Bookings from Booking.com / Agoda / … through Channex (phase O4, migration 0036). Every minute the cron reads the
 * Channex booking revision feed, handles each revision, and only then acknowledges it (Channex offers it again until
 * then, so nothing is lost if a run fails half way).
 *
 *  - new      → a CONFIRMED booking here (code BK-…, guest, nights locked, nightly prices as the OTA sold them).
 *               Paid to the OTA → one PAID payment (method OTHER, reference = the OTA); paid at the property → UNPAID,
 *               staff record the money at check-in. No app fee. Staff hear about it like any new booking (LINE).
 *  - modified → the old booking is cancelled and a new one written in the same batch (changed nights, rooms, amount).
 *  - cancelled→ the booking is cancelled and its nights freed (refunds are handled on the OTA).
 *  - A night already taken here, or a unit that is not bookable → CONFLICT (double booking); a room type no unit is
 *    mapped to → UNMAPPED. Both are listed on the OTA channels page and raised as a CRITICAL security event; the
 *    revision is still acknowledged (it is kept here), staff fix it by hand and mark it resolved.
 */
export class OtaBookingService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: OtaBookingRepository,
    private readonly channels: ChannelRepository,
    private readonly bookings: BookingRepository,
    private readonly notifications: OtaOutbox | null,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly api: ChannexApi | null,
    private readonly today: () => Promise<string>,
  ) {}

  // ================================================================ admin

  async list(actor: AuthContext, meta: RequestMeta): Promise<OtaBookingsDto> {
    await this.authz.requirePermission(actor, "channels.view", meta);
    const [rows, feed] = await Promise.all([this.repo.recent(50), this.channels.feedState()]);
    return {
      supported: feed !== null,
      lastFeedAt: feed?.last_feed_at ?? null,
      lastFeedStatus: feed?.last_feed_status ?? null,
      lastFeedError: feed?.last_feed_error ?? null,
      items: rows.map(toDto),
    };
  }

  /** channels.edit: a CONFLICT / UNMAPPED booking was dealt with by hand. */
  async resolve(actor: AuthContext, id: string, meta: RequestMeta): Promise<OtaBookingDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    const row = await this.repo.byId(id);
    if (!row || (row.status !== "CONFLICT" && row.status !== "UNMAPPED")) throw new NotFoundError("Nothing to resolve", "NOT_FOUND");
    await this.db.batch([
      this.repo.resolveStatement(id, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "OTA_BOOKING_RESOLVED", "channels", id, { status: row.status, problem: row.problem }, { status: "RESOLVED" }, meta),
    ]);
    return toDto((await this.repo.byId(id))!);
  }

  // ================================================================ feed (cron)

  async tick(): Promise<{ handled: number; problems: number } | null> {
    if (!this.api) return null;
    if ((await this.channels.settings())?.channex_enabled !== 1) return null;
    const s = await this.channels.channexSettings();
    if (!s?.property_id || (await this.channels.feedState()) === null) return null;
    const now = iso(this.clock());
    let revisions: ChannexRevision[];
    try {
      revisions = await this.api.bookingFeed(s.property_id, REVISIONS_PER_TICK);
    } catch (error) {
      await this.channels.feedResultStatement("ERROR", errorText(error), now).run();
      return { handled: 0, problems: 0 };
    }
    let handled = 0;
    let problems = 0;
    for (const rev of revisions) {
      if (rev.propertyId && rev.propertyId !== s.property_id) continue;
      try {
        const status = await this.handle(rev);
        if (status === "CONFLICT" || status === "UNMAPPED") problems++;
        await this.api.ackRevision(rev.id);
        handled++;
      } catch (error) {
        // Not acknowledged: Channex offers it again next minute.
        await this.channels.feedResultStatement("ERROR", `${rev.otaName} ${rev.otaCode ?? rev.bookingId}: ${errorText(error)}`, now).run();
        return { handled, problems };
      }
    }
    await this.channels.feedResultStatement("OK", null, now).run();
    return { handled, problems };
  }

  /** One revision → the booking here. Returns the OTA booking's status afterwards. */
  async handle(rev: ChannexRevision): Promise<OtaBookingStatus> {
    const existing = await this.repo.byChannexId(rev.bookingId);
    if (existing && existing.last_revision_id === rev.id) return existing.status; // seen already (ack was lost)
    const now = iso(this.clock());
    const base = {
      id: existing?.id ?? newId(), channexBookingId: rev.bookingId, otaName: rev.otaName, otaCode: rev.otaCode, revisionId: rev.id,
      arrival: isIsoDate(rev.arrival) ? rev.arrival : (existing?.arrival_date ?? "1970-01-01"),
      departure: isIsoDate(rev.departure) ? rev.departure : (existing?.departure_date ?? "1970-01-02"),
      amountMinor: minor(rev.amount), currency: /^[A-Z]{3}$/.test(rev.currency) ? rev.currency : "THB",
      paymentCollect: rev.paymentCollect, guestName: rev.customer.name, now,
    };
    const active = existing?.status === "ACTIVE" && existing.booking_id ? existing : null;

    if (rev.status === "cancelled") {
      const statements: D1PreparedStatementLike[] = [];
      if (active) statements.push(...(await this.cancelStatements(active, `Cancelled on ${rev.otaName}`, now)));
      statements.push(this.repo.upsertStatement({ ...base, bookingId: existing?.booking_id ?? null, status: "CANCELLED", problem: existing?.problem ?? null }));
      statements.push(this.log.auditStatement(null, "OTA_BOOKING_CANCELLED", "channels", base.id, existing ? { status: existing.status } : null,
        { ota: rev.otaName, code: rev.otaCode, booking: existing?.booking_code ?? null }, SYSTEM));
      await this.db.batch(statements);
      return "CANCELLED";
    }

    // new / modified: which house / VIP tent each room is.
    const map = new Map((await this.channels.channexMap()).map((m) => [m.room_type_id, m.unit_id]));
    const rooms = rev.rooms.length ? rev.rooms : [];
    const unmapped = rooms.filter((r) => !r.roomTypeId || !map.has(r.roomTypeId));
    if (!rooms.length || unmapped.length) {
      const problem = rooms.length ? `Room type not mapped: ${unmapped.map((r) => r.roomTypeId ?? "?").join(", ")}` : "No rooms in the booking";
      return this.problem(base, existing, active, "UNMAPPED", problem);
    }
    const stays = rooms.map((r) => ({ ...r, unitId: map.get(r.roomTypeId!)! }));
    if (stays.some((s) => !isIsoDate(s.checkIn) || !isIsoDate(s.checkOut) || s.checkOut <= s.checkIn)) {
      return this.problem(base, existing, active, "CONFLICT", "Invalid stay dates from the OTA");
    }
    // Nothing that matters here changed (e.g. a guest note): keep the booking, remember the revision.
    if (active && existing && sameStay(existing, stays, base.amountMinor)) {
      await this.repo.upsertStatement({ ...base, bookingId: existing.booking_id, status: "ACTIVE", problem: null }).run();
      return "ACTIVE";
    }

    const today = await this.today();
    for (let attempt = 0; attempt < 2; attempt++) {
      const bookingId = newId();
      const code = generateBookingCode(today);
      const statements: D1PreparedStatementLike[] = [];
      if (active) statements.push(...(await this.cancelStatements(active, `Changed on ${rev.otaName} (new booking ${code})`, now)));
      statements.push(...(await this.bookingStatements(rev, stays, bookingId, code, now)));
      statements.push(this.repo.upsertStatement({ ...base, bookingId, status: "ACTIVE", problem: null }));
      statements.push(this.log.auditStatement(null, active ? "OTA_BOOKING_MODIFIED" : "OTA_BOOKING_CREATED", "channels", base.id,
        active ? { booking: active.booking_code } : null, { ota: rev.otaName, code: rev.otaCode, booking: code }, SYSTEM));
      try {
        await this.db.batch(statements);
        return "ACTIVE";
      } catch (error) {
        const text = String(error);
        if (/UNIQUE constraint failed: bookings\.booking_code/.test(text)) continue;
        if (/UNIQUE constraint failed: booking_unit_nights/.test(text)) {
          return this.problem(base, existing, active, "CONFLICT", `Nights already booked here (${rev.arrival} → ${rev.departure})`);
        }
        if (/UNIT_NOT_BOOKABLE/.test(text)) return this.problem(base, existing, active, "CONFLICT", "The unit is not open for booking here");
        throw error;
      }
    }
    throw new Error("Could not write the booking");
  }

  // ================================================================ helpers

  /** Keeps the revision as a problem; a booking already here stays as it was (staff decide). */
  private async problem(base: Omit<Parameters<OtaBookingRepository["upsertStatement"]>[0], "bookingId" | "status" | "problem">,
    existing: OtaBookingRow | null, active: OtaBookingRow | null, status: "CONFLICT" | "UNMAPPED", problem: string): Promise<OtaBookingStatus> {
    const text = active ? `${problem} — the booking ${active.booking_code} here is unchanged` : problem;
    await this.db.batch([
      this.repo.upsertStatement({ ...base, bookingId: active?.booking_id ?? existing?.booking_id ?? null, status, problem: text }),
      this.log.eventStatement("OTA_BOOKING_CONFLICT", "CRITICAL", SYSTEM, {
        identifier: `${base.otaName}:${base.otaCode ?? base.channexBookingId}`,
        details: { status, problem: text, arrival: base.arrival, departure: base.departure, guest: base.guestName },
      }),
    ]);
    return status;
  }

  private async cancelStatements(active: OtaBookingRow, reason: string, now: string): Promise<D1PreparedStatementLike[]> {
    const booking = await this.bookings.findById(active.booking_id!);
    if (!booking || !["PENDING", "CONFIRMED"].includes(booking.booking_status)) return [];
    return [
      this.bookings.cancelStatement(booking.id, null as unknown as string, reason.slice(0, 200), now),
      ...this.bookings.releaseStatements(booking.id, booking.check_in, booking.check_out, now),
      ...(this.notifications ? await this.notifications.bookingCancelled(booking.id, booking.booking_status === "CONFIRMED", now) : []),
    ];
  }

  private async bookingStatements(rev: ChannexRevision, stays: (ChannexRevision["rooms"][number] & { unitId: string })[], bookingId: string, code: string, now: string): Promise<D1PreparedStatementLike[]> {
    const checkIn = stays.map((s) => s.checkIn).sort()[0]!;
    const checkOut = stays.map((s) => s.checkOut).sort().at(-1)!;
    const names = await this.repo.unitNames(stays.map((s) => s.unitId));
    const units = new Map((await this.channels.channexUnits()).map((u) => [u.id, u]));
    const priced = stays.map((s) => {
      const nights = stayNights(s.checkIn, s.checkOut);
      const total = minor(s.amount);
      // The OTA's own nightly prices when given; otherwise the stay's amount spread over its nights.
      const each = nights.map((date, i) => {
        const day = s.days[date];
        if (day !== undefined) return { date, priceSatang: minor(day) };
        const even = Math.floor(total / nights.length);
        return { date, priceSatang: i === nights.length - 1 ? total - even * (nights.length - 1) : even };
      });
      return { ...s, nights, nightly: each, subtotal: each.reduce((a, n) => a + n.priceSatang, 0) };
    });
    const subtotal = priced.reduce((a, s) => a + s.subtotal, 0);
    const paid = rev.paymentCollect === "ota" && subtotal > 0;
    const phone = rev.customer.phone ? normalizePhone(rev.customer.phone) : null;
    const lang = rev.customer.language?.toLowerCase().startsWith("th") ? "th" : rev.customer.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    const payNote = rev.paymentCollect === "ota" ? "paid to the OTA" : rev.paymentCollect === "property" ? "pay at the property" : "payment: see the OTA";
    const statements: D1PreparedStatementLike[] = [
      this.repo.insertBookingStatement({
        id: bookingId, code, lang, checkIn, checkOut, nights: diffDays(checkIn, checkOut),
        adults: Math.max(1, priced.reduce((a, s) => a + s.adults, 0)), children: priced.reduce((a, s) => a + s.children, 0),
        name: rev.customer.name.slice(0, 200), phone: (rev.customer.phone ?? "-").slice(0, 40), phoneNormalized: phone ?? "000000",
        email: rev.customer.email?.slice(0, 254) ?? null,
        note: rev.notes?.slice(0, 1000) ?? null,
        adminNote: `${rev.otaName} ${rev.otaCode ?? ""} · ${payNote} · Channex ${rev.bookingId}`.replace(/\s+/g, " ").trim().slice(0, 500),
        subtotal, currency: /^[A-Z]{3}$/.test(rev.currency) ? rev.currency : "THB", paid, now,
      }),
      this.repo.insertAccountSnapshotStatement(bookingId, now),
    ];
    for (const s of priced) {
      const itemId = newId();
      const unit = units.get(s.unitId);
      statements.push(
        this.bookings.insertItemStatement({ id: itemId, bookingId, type: unit?.unit_type ?? "HOUSE", unitId: s.unitId, quantity: 1, adults: s.adults, children: s.children, payLater: 0, now }),
        ...s.nights.map((d) => this.bookings.lockNightStatement(s.unitId, d, bookingId, itemId, now)),
        this.bookings.insertPriceSnapshotStatement({
          id: newId(), bookingId, itemId, unitId: s.unitId, name: names.get(s.unitId) ?? unit?.unit_code ?? s.unitId, unitType: unit?.unit_type ?? "HOUSE",
          price: s.nightly[0]?.priceSatang ?? 0, pricingType: "PER_UNIT_NIGHT", quantity: 1, nights: s.nights.length,
          adults: s.adults, children: s.children, nightlyJson: JSON.stringify(s.nightly), subtotal: s.subtotal, now,
        }),
      );
    }
    if (paid) statements.push(this.repo.insertOtaPaymentStatement({ id: newId(), bookingId, amount: subtotal, reference: `${rev.otaName} ${rev.otaCode ?? ""}`.trim(), now }));
    if (this.notifications) statements.push(...(await this.notifications.bookingCreated(bookingId, now)));
    return statements;
  }
}

/** "1800.00" → 180000 (minor units); junk → 0. */
export function minor(amount: string | null | undefined): number {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function sameStay(existing: OtaBookingRow, stays: { checkIn: string; checkOut: string }[], amountMinor: number): boolean {
  const checkIn = stays.map((s) => s.checkIn).sort()[0];
  const checkOut = stays.map((s) => s.checkOut).sort().at(-1);
  return stays.length === 1 && existing.arrival_date === checkIn && existing.departure_date === checkOut && existing.amount_minor === amountMinor;
}

function toDto(r: OtaBookingRow): OtaBookingDto {
  return {
    id: r.id, otaName: r.ota_name, otaCode: r.ota_code, status: r.status, bookingCode: r.booking_code, arrival: r.arrival_date,
    departure: r.departure_date, amountMinor: r.amount_minor, currency: r.currency, paymentCollect: r.payment_collect,
    guestName: r.guest_name, problem: r.problem, updatedAt: r.updated_at,
  };
}

function errorText(error: unknown): string {
  if (error instanceof ChannexError) return `${error.code}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}
