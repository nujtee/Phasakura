import {
  ICAL_CHANNELS, ICAL_IMPORT_EVERY_MINUTES, ICAL_LABEL_MAX, icalChannelName,
  type CenterChannelsDto, type ChannelsDto, type IcalChannel, type IcalFeedDto,
} from "../../shared/channel-types.ts";
import { STAY_RULES } from "../../shared/booking-rules.ts";
import { addDays } from "../../shared/dates.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { ChannelRepository, IcalFeedRow } from "../repositories/channel.repository.ts";
import { newId, randomToken } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { IcsError, buildIcs, nightsOf, parseIcs, rangesOf } from "./ical.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import type { ChannexService } from "./channex.service.ts";

export type ChannelFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Largest OTA calendar we read (a year of one room is a few kB). */
export const ICAL_MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Feeds read per cron run (each is one HTTP request). */
/** Feeds read per cron run, a few at a time (every linked calendar is due every 5 minutes). */
const FEEDS_PER_TICK = 12;
const FEEDS_AT_ONCE = 4;
const EXPORT_MARK_EVERY_MS = 10 * 60_000;
/** Nights kept in sync: from today to the furthest a guest can book (+ a margin). */
const SYNC_DAYS = STAY_RULES.maxAdvanceDays + 30;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type ChannelSwitches = { ical?: boolean; channex?: boolean };

/**
 * OTA channels (phase O1, migration 0033).
 *
 * The switch: `channel_settings` — iCal (and, later, Channex) are OFF until a SUPER_ADMIN (channels.toggle) or Center
 * switches them on. Off = the calendar links answer 404 and nothing is imported; nights already imported stay
 * blocked (safer than freeing nights an OTA may have sold) until an import link is removed.
 *
 * iCal, per house / VIP tent and per channel (Booking.com, Agoda, Airbnb):
 *  - Export: /api/public/ical/<secret>.ics — every night that is not free here (bookings, staff blocks, nights
 *    imported from the OTHER channel), as all-day "Not available" events. No guest data, ever.
 *  - Import: the OTA's calendar link is read every 5 minutes; its nights become blocks here ("iCal · Booking.com")
 *    that staff cannot unlock by hand (the next read would bring them back). A night the OTA sold that is already
 *    booked here is a double booking: kept in ical_conflicts, shown on the Channels page and raised as a CRITICAL
 *    security event (System status). It clears itself when either side frees the night.
 */
export class ChannelService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: ChannelRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly today: () => Promise<string>,
    private readonly origin: string,
    private readonly fetcher: ChannelFetch = (input, init) => fetch(input, init),
    readonly channex: ChannexService | null = null,
  ) {}

  async icalEnabled(): Promise<boolean> {
    return (await this.repo.settings())?.ical_enabled === 1;
  }

  // ================================================================ admin

  async overview(actor: AuthContext, meta: RequestMeta): Promise<ChannelsDto> {
    await this.authz.requirePermission(actor, "channels.view", meta);
    const canEdit = this.authz.can(actor, "channels.edit");
    const settings = await this.repo.settings();
    const enabled = settings?.ical_enabled === 1;
    // Every unit gets its feeds (and secret links) the first time someone who can edit opens the page.
    if (enabled && canEdit) await this.ensureFeeds();
    const today = await this.today();
    const [units, feeds, counts, conflicts] = await Promise.all([
      this.repo.units(), this.repo.feeds(), this.repo.importedCounts(today), this.repo.conflicts(today),
    ]);
    const unitInfo = new Map<string, { code: string; type: "HOUSE" | "VIP_TENT"; names: Partial<Record<LocaleCode, string>> }>();
    for (const u of units) {
      const info = unitInfo.get(u.id) ?? { code: u.unit_code, type: u.unit_type, names: {} };
      if (u.language_code && u.name) info.names[u.language_code as LocaleCode] = u.name;
      unitInfo.set(u.id, info);
    }
    const order = [...unitInfo.keys()];
    const feedDtos: IcalFeedDto[] = feeds
      .filter((f) => unitInfo.has(f.unit_id))
      .sort((a, b) => order.indexOf(a.unit_id) - order.indexOf(b.unit_id) || ICAL_CHANNELS.indexOf(a.channel) - ICAL_CHANNELS.indexOf(b.channel))
      .map((f) => {
        const u = unitInfo.get(f.unit_id)!;
        return {
          unitId: f.unit_id, unitCode: u.code, unitType: u.type, names: u.names, channel: f.channel, label: f.label,
          exportUrl: canEdit ? this.exportUrl(f.export_token) : null,
          importUrl: canEdit ? f.import_url : null,
          importSet: f.import_url !== null,
          lastImportAt: f.last_import_at, lastImportStatus: f.last_import_status, lastImportError: f.last_import_error,
          importedNights: counts.get(f.id) ?? 0, lastExportAt: f.last_export_at,
        };
      });
    return {
      ical: {
        enabled,
        feeds: feedDtos,
        conflicts: conflicts.map((c) => ({
          unitId: c.unit_id, unitCode: c.unit_code, channel: c.channel, label: c.label, date: c.stay_date, bookingCode: c.booking_code,
          summary: c.summary, firstSeenAt: c.first_seen_at,
        })),
      },
      channex: this.channex
        ? await this.channex.status(settings?.channex_enabled === 1)
        : { enabled: false, available: false, environment: "staging", property: null, lastCheckAt: null, lastCheckStatus: null, lastCheckError: null, units: [] },
      updatedAt: settings?.updated_at ?? null,
      canToggle: this.authz.can(actor, "channels.toggle"),
      canEdit,
    };
  }

  /** SUPER_ADMIN (channels.toggle): switch iCal and / or Channex on / off. */
  async setEnabled(actor: AuthContext, change: ChannelSwitches, meta: RequestMeta): Promise<ChannelsDto> {
    await this.authz.requirePermission(actor, "channels.toggle", meta);
    await this.switchFeatures(change, actor.userId, null, meta);
    return this.overview(actor, meta);
  }

  /**
   * channels.edit: the OTA's calendar link for one unit (null = unlink: its imported nights are freed) and, for the
   * OTHER channel, the OTA's name. `undefined` leaves a field as it is.
   */
  async setImportUrl(actor: AuthContext, unitId: string, channel: IcalChannel, url: string | null | undefined, meta: RequestMeta,
    label?: string | null): Promise<IcalFeedDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    await this.requireEnabled();
    if (label !== undefined && channel !== "OTHER") throw new ValidationError({ label: "NOT_ALLOWED" });
    const name = label === undefined ? undefined : label?.trim() || null;
    if (name && name.length > ICAL_LABEL_MAX) throw new ValidationError({ label: "TOO_LONG" });
    const feed = await this.feedFor(unitId, channel);
    const clean = url === undefined ? feed.import_url : url === null ? null : validImportUrl(url);
    const now = iso(this.clock());
    const today = await this.today();
    const statements: D1PreparedStatementLike[] = [];
    if (name !== undefined && name !== feed.label) {
      statements.push(this.repo.setLabelStatement(feed.id, name, now),
        this.repo.renameImportedStatement(feed.id, `iCal · ${icalChannelName(channel, name)}`));
    }
    const linkChanged = url !== undefined && clean !== feed.import_url;
    if (linkChanged || url === null) {
      // A new link (or none): the old link's nights go; the new one is read straight away.
      statements.push(this.repo.setImportUrlStatement(feed.id, clean, now),
        this.repo.clearImportedStatement(feed.id, today), this.repo.clearConflictsStatement(feed.id));
    }
    if (statements.length) {
      statements.push(this.log.auditStatement(actor.userId, url === undefined ? "ICAL_FEED_RENAMED" : clean ? "ICAL_IMPORT_SET" : "ICAL_IMPORT_REMOVED",
        "channels", feed.id, { unitId, channel, label: feed.label, host: hostOf(feed.import_url) },
        { unitId, channel, label: name === undefined ? feed.label : name, host: hostOf(clean) }, meta));
      await this.db.batch(statements);
    }
    if (clean && (linkChanged || url !== undefined)) await this.syncFeed((await this.repo.feed(unitId, channel))!);
    return this.feedDto(actor, unitId, channel);
  }

  /** channels.edit: a new secret calendar link (the old one stops working — paste the new one into the OTA). */
  async rotateToken(actor: AuthContext, unitId: string, channel: IcalChannel, meta: RequestMeta): Promise<IcalFeedDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    await this.requireEnabled();
    const feed = await this.feedFor(unitId, channel);
    await this.db.batch([
      this.repo.setTokenStatement(feed.id, randomToken(32), iso(this.clock())),
      this.log.auditStatement(actor.userId, "ICAL_EXPORT_LINK_RENEWED", "channels", feed.id, null, { unitId, channel }, meta),
    ]);
    return this.feedDto(actor, unitId, channel);
  }

  /** channels.edit: read the OTA calendar now. */
  async syncNow(actor: AuthContext, unitId: string, channel: IcalChannel, meta: RequestMeta): Promise<IcalFeedDto> {
    await this.authz.requirePermission(actor, "channels.edit", meta);
    await this.requireEnabled();
    const feed = await this.feedFor(unitId, channel);
    if (!feed.import_url) throw new ValidationError({ importUrl: "REQUIRED" });
    await this.syncFeed(feed);
    return this.feedDto(actor, unitId, channel);
  }

  // ================================================================ Center

  async centerOverview(): Promise<CenterChannelsDto> {
    const settings = await this.repo.settings();
    const available = this.channex?.configured ?? false;
    const environment = this.channex?.environment ?? "staging";
    if (!settings) return { ical: { enabled: false, feedsWithImport: 0, errors: 0, conflicts: 0, lastImportAt: null }, channex: { enabled: false, available, environment, propertyTitle: null, mappedUnits: 0 }, updatedAt: null };
    const [feeds, conflicts] = await Promise.all([this.repo.feeds(), this.repo.conflicts(await this.today())]);
    const linked = feeds.filter((f) => f.import_url);
    return {
      ical: {
        enabled: settings.ical_enabled === 1,
        feedsWithImport: linked.length,
        errors: linked.filter((f) => f.last_import_status === "ERROR").length,
        conflicts: conflicts.length,
        lastImportAt: linked.map((f) => f.last_import_at).filter((x): x is string => !!x).sort().at(-1) ?? null,
      },
      channex: await (async () => {
        const st = this.channex ? await this.channex.status(settings.channex_enabled === 1) : null;
        return { enabled: settings.channex_enabled === 1, available, environment, propertyTitle: st?.property?.title ?? null, mappedUnits: st?.units.filter((u) => u.roomTypeId).length ?? 0 };
      })(),
      updatedAt: settings.updated_at,
    };
  }

  /**
   * The switches, from the site's SUPER_ADMIN or Center (PLATFORM_OWNER / OPERATOR, checked by CenterAdminService,
   * audited as the Center user). Channex can be switched on only once CHANNEX_API_KEY is set on the site.
   */
  async switchFeatures(change: ChannelSwitches, userId: string | null, extraStatements: D1PreparedStatementLike[] | null, meta: RequestMeta,
    audit: { reason?: string; center?: unknown } = {}): Promise<void> {
    if (change.ical === undefined && change.channex === undefined) throw new ValidationError({ ical: "REQUIRED" });
    const before = await this.repo.settings();
    if (!before) throw new ConflictError("Run the database migrations first", "SCHEMA_OUTDATED");
    if (change.channex === true && !this.channex?.configured) {
      throw new ConflictError("Set the CHANNEX_API_KEY secret on this site first", "CHANNEX_NOT_CONFIGURED");
    }
    const now = iso(this.clock());
    const statements: D1PreparedStatementLike[] = [...(extraStatements ?? [])];
    if (change.ical !== undefined) {
      statements.push(this.repo.setIcalStatement(change.ical, userId, now),
        this.log.auditStatement(userId, change.ical ? "CHANNEL_ICAL_ON" : "CHANNEL_ICAL_OFF", "channels", "ical",
          { ical: before.ical_enabled === 1 }, { ical: change.ical, ...audit }, meta));
    }
    if (change.channex !== undefined) {
      statements.push(this.repo.setChannexStatement(change.channex, userId, now),
        this.log.auditStatement(userId, change.channex ? "CHANNEL_CHANNEX_ON" : "CHANNEL_CHANNEX_OFF", "channels", "channex",
          { channex: before.channex_enabled === 1 }, { channex: change.channex, ...audit }, meta));
    }
    await this.db.batch(statements);
  }

  // ================================================================ export (public)

  /** The .ics for a secret link; null = unknown link or iCal off (404). */
  async exportCalendar(file: string): Promise<string | null> {
    const token = file.endsWith(".ics") ? file.slice(0, -4) : file;
    if (!TOKEN.test(token)) return null;
    if (!(await this.icalEnabled())) return null;
    const feed = await this.repo.feedByToken(token);
    if (!feed) return null;
    const unit = (await this.repo.units()).find((u) => u.id === feed.unit_id);
    if (!unit) return null;
    const today = await this.today();
    // Yesterday on: an OTA that reads just after midnight still sees the night that is ending.
    const nights = await this.repo.unavailableNights(feed.unit_id, feed.id, addDays(today, -1), addDays(today, SYNC_DAYS));
    const now = this.clock();
    await this.repo.markExported(feed.id, iso(now), iso(new Date(now.getTime() - EXPORT_MARK_EVERY_MS)));
    return buildIcs({ name: unit.unit_code, uidPrefix: `${feed.unit_id}-${feed.channel.toLowerCase()}`, host: new URL(this.origin).host, ranges: rangesOf(nights), now });
  }

  // ================================================================ import (cron)

  /** Reads the OTA calendars that are due (every 5 minutes each), a few in parallel. */
  async tick(): Promise<{ read: number; failed: number; conflicts: number }> {
    if (!(await this.icalEnabled())) return { read: 0, failed: 0, conflicts: 0 };
    const now = this.clock();
    const due = await this.repo.dueFeeds(iso(new Date(now.getTime() - (ICAL_IMPORT_EVERY_MINUTES * 60_000 - 30_000))), FEEDS_PER_TICK);
    let failed = 0;
    let conflicts = 0;
    for (let i = 0; i < due.length; i += FEEDS_AT_ONCE) {
      // Different units never touch the same nights; the same unit's feeds are written in their own batches.
      for (const r of await Promise.all(due.slice(i, i + FEEDS_AT_ONCE).map((f) => this.syncFeed(f)))) {
        if (!r.ok) failed++;
        conflicts += r.newConflicts;
      }
    }
    return { read: due.length, failed, conflicts };
  }

  /** Reads one OTA calendar and brings this unit's imported nights in line with it (one batch). */
  async syncFeed(feed: IcalFeedRow): Promise<{ ok: boolean; newConflicts: number }> {
    const now = iso(this.clock());
    if (!feed.import_url) return { ok: true, newConflicts: 0 };
    let text: string;
    try {
      text = await this.download(feed.import_url);
    } catch (error) {
      await this.repo.importResultStatement(feed.id, "ERROR", error instanceof Error ? error.message : String(error), null, now).run();
      return { ok: false, newConflicts: 0 };
    }
    let events;
    try {
      events = parseIcs(text);
    } catch (error) {
      await this.repo.importResultStatement(feed.id, "ERROR", error instanceof IcsError ? error.message : "NOT_A_CALENDAR", null, now).run();
      return { ok: false, newConflicts: 0 };
    }
    const today = await this.today();
    const until = addDays(today, SYNC_DAYS);
    const wanted = nightsOf(events, today, until);
    const summaries = new Map<string, string | null>();
    for (const e of events) for (const d of nightsOf([e], today, until)) if (!summaries.has(d)) summaries.set(d, e.summary);

    const locks = await this.repo.unitLocks(feed.unit_id, today, until);
    const mine = new Set(locks.filter((l) => l.ical_feed_id === feed.id).map((l) => l.stay_date));
    const others = new Map(locks.filter((l) => l.ical_feed_id !== feed.id).map((l) => [l.stay_date, l]));
    const reason = `iCal · ${icalChannelName(feed.channel, feed.label)}`;
    const statements: D1PreparedStatementLike[] = [];
    const conflictNow = new Map<string, string>();
    for (const d of wanted) {
      if (mine.has(d)) continue;
      const other = others.get(d);
      if (!other) statements.push(this.repo.insertImportedNightStatement(feed.unit_id, d, feed.id, reason, now));
      else if (other.booking_id) conflictNow.set(d, other.booking_id);
      // Blocked here already (staff or the other OTA): nothing to do; it is taken once that block goes.
    }
    for (const d of mine) if (!wanted.has(d)) statements.push(this.repo.deleteImportedNightStatement(feed.id, d));

    const known = new Set(await this.repo.feedConflictDates(feed.id));
    const fresh = [...conflictNow.keys()].filter((d) => !known.has(d)).sort();
    for (const d of fresh) statements.push(this.repo.insertConflictStatement(feed.id, d, conflictNow.get(d)!, summaries.get(d) ?? null, now));
    for (const d of known) if (!conflictNow.has(d)) statements.push(this.repo.deleteConflictStatement(feed.id, d));
    statements.push(this.repo.importResultStatement(feed.id, "OK", null, wanted.size, now));
    if (fresh.length) {
      statements.push(this.log.eventStatement("ICAL_DOUBLE_BOOKING", "CRITICAL", { ip: null, userAgent: null }, {
        identifier: `${feed.unit_id}:${feed.channel}`,
        details: { unitId: feed.unit_id, channel: feed.channel, nights: fresh.slice(0, 31), count: fresh.length },
      }));
    }
    try {
      await this.db.batch(statements);
    } catch (error) {
      // A guest booked one of these nights here while we read: the next read sorts it out.
      const busy = /UNIQUE constraint failed: booking_unit_nights/.test(String(error));
      await this.repo.importResultStatement(feed.id, "ERROR", busy ? "BUSY_RETRY" : String(error).slice(0, 200), null, now).run();
      return { ok: false, newConflicts: 0 };
    }
    return { ok: true, newConflicts: fresh.length };
  }

  private async download(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await this.fetcher(url, {
          method: "GET", redirect: "follow", signal: controller.signal,
          headers: { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1", "User-Agent": "PhasakuraCalendarSync/1.0" },
        });
      } catch {
        throw new Error(controller.signal.aborted ? "TIMEOUT" : "UNREACHABLE");
      }
      if (res.url && !res.url.startsWith("https://")) throw new Error("NOT_HTTPS");
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      const length = Number(res.headers.get("Content-Length") ?? "0");
      if (length > ICAL_MAX_BYTES) throw new Error("TOO_LARGE");
      const text = await res.text();
      if (text.length > ICAL_MAX_BYTES) throw new Error("TOO_LARGE");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // ================================================================ helpers

  private exportUrl(token: string): string {
    return `${this.origin.replace(/\/$/, "")}/api/public/ical/${token}.ics`;
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.icalEnabled())) throw new ConflictError("iCal is switched off", "ICAL_DISABLED");
  }

  private async ensureFeeds(): Promise<void> {
    const [units, feeds] = await Promise.all([this.repo.units(), this.repo.feeds()]);
    const have = new Set(feeds.map((f) => `${f.unit_id}|${f.channel}`));
    const now = iso(this.clock());
    const missing = [...new Set(units.map((u) => u.id))].flatMap((id) => ICAL_CHANNELS.filter((c) => !have.has(`${id}|${c}`)).map((c) => [id, c] as const));
    if (missing.length) await this.db.batch(missing.map(([id, c]) => this.repo.createFeedStatement(newId(), id, c, randomToken(32), now)));
  }

  private async feedFor(unitId: string, channel: IcalChannel): Promise<IcalFeedRow> {
    if (!ICAL_CHANNELS.includes(channel)) throw new ValidationError({ channel: "INVALID_VALUE" });
    if (!(await this.repo.units()).some((u) => u.id === unitId)) throw new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
    await this.ensureFeeds();
    return (await this.repo.feed(unitId, channel))!;
  }

  private async feedDto(actor: AuthContext, unitId: string, channel: IcalChannel): Promise<IcalFeedDto> {
    const all = await this.overview(actor, { ip: null, userAgent: null });
    return all.ical.feeds.find((f) => f.unitId === unitId && f.channel === channel)!;
  }
}

/** An OTA calendar link: https, a public host name, no user / password, ≤ 2000 characters. */
export function validImportUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError({ importUrl: "INVALID_URL" });
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || value.length > 2000 || url.username || url.password || (url.port && url.port !== "443")
    || !host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || host === "localhost" || host.endsWith(".localhost")
    || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ValidationError({ importUrl: "INVALID_URL" });
  }
  return url.toString();
}

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}
