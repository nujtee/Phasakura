import type { IcalChannel } from "../../shared/channel-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { isMissingSchema } from "./inventory.repository.ts";

export interface ChannelSettingsRow {
  ical_enabled: number;
  channex_enabled: number;
  updated_by: string | null;
  updated_at: string | null;
}

export interface IcalFeedRow {
  id: string;
  unit_id: string;
  channel: IcalChannel;
  label: string | null;
  export_token: string;
  import_url: string | null;
  last_import_at: string | null;
  last_import_status: "OK" | "ERROR" | null;
  last_import_error: string | null;
  last_import_nights: number | null;
  last_export_at: string | null;
}

export interface FeedUnitRow {
  id: string;
  unit_type: "HOUSE" | "VIP_TENT";
  unit_code: string;
  language_code: string | null;
  name: string | null;
}

export interface IcalConflictRow {
  feed_id: string;
  unit_id: string;
  unit_code: string;
  channel: IcalChannel;
  label: string | null;
  stay_date: string;
  booking_code: string | null;
  summary: string | null;
  first_seen_at: string;
}

const FEED_COLUMNS = `id, unit_id, channel, label, export_token, import_url, last_import_at, last_import_status, last_import_error,
  last_import_nights, last_export_at`;

/** OTA channels (migration 0033): the on / off switch, iCal feeds, their imported nights and double bookings. */
export class ChannelRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** null before migration 0033 (every channel feature is off). */
  async settings(): Promise<ChannelSettingsRow | null> {
    try {
      return await this.db
        .prepare("SELECT ical_enabled, channex_enabled, updated_by, updated_at FROM channel_settings WHERE id = 1")
        .first<ChannelSettingsRow>();
    } catch (error) {
      if (isMissingSchema(error)) return null;
      throw error;
    }
  }

  setIcalStatement(enabled: boolean, userId: string | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE channel_settings SET ical_enabled = ?1, updated_by = ?2, updated_at = ?3 WHERE id = 1")
      .bind(enabled ? 1 : 0, userId, now);
  }

  async units(): Promise<FeedUnitRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.unit_type, u.unit_code, t.language_code, t.name
           FROM accommodation_units u LEFT JOIN accommodation_translations t ON t.unit_id = u.id
          WHERE u.status <> 'DELETED'
          ORDER BY u.unit_type, u.sort_order, u.unit_code`,
      )
      .all<FeedUnitRow>();
    return results;
  }

  /** A feed for every unit and channel that has none yet (each with its own secret export token). */
  createFeedStatement(id: string, unitId: string, channel: IcalChannel, token: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO ical_feeds (id, unit_id, channel, export_token, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      )
      .bind(id, unitId, channel, token, now);
  }

  async feeds(): Promise<IcalFeedRow[]> {
    const { results } = await this.db.prepare(`SELECT ${FEED_COLUMNS} FROM ical_feeds ORDER BY unit_id, channel`).all<IcalFeedRow>();
    return results;
  }

  async feed(unitId: string, channel: IcalChannel): Promise<IcalFeedRow | null> {
    return this.db.prepare(`SELECT ${FEED_COLUMNS} FROM ical_feeds WHERE unit_id = ?1 AND channel = ?2`).bind(unitId, channel).first<IcalFeedRow>();
  }

  async feedByToken(token: string): Promise<IcalFeedRow | null> {
    try {
      return await this.db.prepare(`SELECT ${FEED_COLUMNS} FROM ical_feeds WHERE export_token = ?1`).bind(token).first<IcalFeedRow>();
    } catch (error) {
      if (isMissingSchema(error)) return null;
      throw error;
    }
  }

  /** Feeds with an import link whose last read is older than `before` (never read first). */
  async dueFeeds(before: string, limit: number): Promise<IcalFeedRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${FEED_COLUMNS} FROM ical_feeds
          WHERE import_url IS NOT NULL AND (last_import_at IS NULL OR last_import_at < ?1)
          ORDER BY last_import_at IS NOT NULL, last_import_at LIMIT ?2`,
      )
      .bind(before, limit)
      .all<IcalFeedRow>();
    return results;
  }

  setLabelStatement(feedId: string, label: string | null, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE ical_feeds SET label = ?2, updated_at = ?3 WHERE id = ?1").bind(feedId, label, now);
  }

  setImportUrlStatement(feedId: string, url: string | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE ical_feeds SET import_url = ?2, updated_at = ?3,
                last_import_at = NULL, last_import_status = NULL, last_import_error = NULL, last_import_nights = NULL
          WHERE id = ?1`,
      )
      .bind(feedId, url, now);
  }

  setTokenStatement(feedId: string, token: string, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE ical_feeds SET export_token = ?2, last_export_at = NULL, updated_at = ?3 WHERE id = ?1").bind(feedId, token, now);
  }

  importResultStatement(feedId: string, status: "OK" | "ERROR", error: string | null, nights: number | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE ical_feeds SET last_import_at = ?2, last_import_status = ?3, last_import_error = ?4,
                last_import_nights = COALESCE(?5, last_import_nights)
          WHERE id = ?1`,
      )
      .bind(feedId, now, status, error?.slice(0, 300) ?? null, nights);
  }

  /** Remembered at most every few minutes (the OTA reads often; no write per read). */
  async markExported(feedId: string, now: string, notSince: string): Promise<void> {
    await this.db
      .prepare("UPDATE ical_feeds SET last_export_at = ?2 WHERE id = ?1 AND (last_export_at IS NULL OR last_export_at < ?3)")
      .bind(feedId, now, notSince)
      .run();
  }

  /** Nights of a unit that are not free, apart from the ones this feed itself imported (no echo back to the OTA). */
  async unavailableNights(unitId: string, exceptFeedId: string, from: string, toExclusive: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT stay_date FROM booking_unit_nights
          WHERE unit_id = ?1 AND stay_date >= ?2 AND stay_date < ?3 AND (ical_feed_id IS NULL OR ical_feed_id <> ?4)
          ORDER BY stay_date`,
      )
      .bind(unitId, from, toExclusive, exceptFeedId)
      .all<{ stay_date: string }>();
    return results.map((r) => r.stay_date);
  }

  /** Every night-lock of a unit from `from`: who holds it (a booking, a staff block, an iCal feed). */
  async unitLocks(unitId: string, from: string, toExclusive: string): Promise<{ stay_date: string; booking_id: string | null; ical_feed_id: string | null }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT stay_date, booking_id, ical_feed_id FROM booking_unit_nights
          WHERE unit_id = ?1 AND stay_date >= ?2 AND stay_date < ?3`,
      )
      .bind(unitId, from, toExclusive)
      .all<{ stay_date: string; booking_id: string | null; ical_feed_id: string | null }>();
    return results;
  }

  insertImportedNightStatement(unitId: string, date: string, feedId: string, reason: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason, created_at, ical_feed_id)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(unitId, date, reason, now, feedId);
  }

  deleteImportedNightStatement(feedId: string, date: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM booking_unit_nights WHERE ical_feed_id = ?1 AND stay_date = ?2 AND booking_id IS NULL").bind(feedId, date);
  }

  /** The OTHER OTA got a new name: its nights say so (the calendar shows the reason). */
  renameImportedStatement(feedId: string, reason: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE booking_unit_nights SET block_reason = ?2 WHERE ical_feed_id = ?1 AND booking_id IS NULL").bind(feedId, reason);
  }

  /** Every night a feed imported, from `from` on (unlinking the OTA calendar frees them). */
  clearImportedStatement(feedId: string, from: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM booking_unit_nights WHERE ical_feed_id = ?1 AND stay_date >= ?2 AND booking_id IS NULL").bind(feedId, from);
  }

  async importedCounts(from: string): Promise<Map<string, number>> {
    const { results } = await this.db
      .prepare("SELECT ical_feed_id, COUNT(*) AS n FROM booking_unit_nights WHERE ical_feed_id IS NOT NULL AND stay_date >= ?1 GROUP BY ical_feed_id")
      .bind(from)
      .all<{ ical_feed_id: string; n: number }>();
    return new Map(results.map((r) => [r.ical_feed_id, r.n]));
  }

  async conflicts(from: string): Promise<IcalConflictRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.feed_id, f.unit_id, u.unit_code, f.channel, f.label, c.stay_date, b.booking_code, c.summary, c.first_seen_at
           FROM ical_conflicts c JOIN ical_feeds f ON f.id = c.feed_id JOIN accommodation_units u ON u.id = f.unit_id
           LEFT JOIN bookings b ON b.id = c.booking_id
          WHERE c.stay_date >= ?1 ORDER BY c.stay_date, u.unit_code LIMIT 200`,
      )
      .bind(from)
      .all<IcalConflictRow>();
    return results;
  }

  async feedConflictDates(feedId: string): Promise<string[]> {
    const { results } = await this.db.prepare("SELECT stay_date FROM ical_conflicts WHERE feed_id = ?1").bind(feedId).all<{ stay_date: string }>();
    return results.map((r) => r.stay_date);
  }

  insertConflictStatement(feedId: string, date: string, bookingId: string, summary: string | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("INSERT OR IGNORE INTO ical_conflicts (feed_id, stay_date, booking_id, summary, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(feedId, date, bookingId, summary, now);
  }

  deleteConflictStatement(feedId: string, date: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM ical_conflicts WHERE feed_id = ?1 AND stay_date = ?2").bind(feedId, date);
  }

  clearConflictsStatement(feedId: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM ical_conflicts WHERE feed_id = ?1").bind(feedId);
  }
}
