import type { HealthDto } from "../../shared/system-types.ts";
import type { HealthRepository } from "../repositories/health.repository.ts";

/**
 * The newest migration this code expects (Phase 16). A test keeps it equal to the last file in
 * migrations/, so a deploy whose migrations were not applied shows up as `schema: "outdated"`.
 */
export const LATEST_MIGRATION = "0050_massage.sql";
/**
 * Schema probe where D1's migration list cannot be read: what the newest migrations created or changed
 * (0020 error_events, 0021 booking_tarps, 0022 the rewritten bookings CHECK, 0023 payment settings and
 * the e-mail outbox, 0024 the admin menu, 0025 the booking deposit, 0026 several stays per booking, 0027 app-usage credits, 0028 the top-up QR receiver, 0029 the SUPER_ADMIN grant trigger, 0030 Center request nonces, 0031 Center SSO tickets and site suspension, 0032 calendar locks on camping nights, 0033 OTA channels / iCal, 0034 the Channex connection, 0035 availability / prices to Channex, 0036 OTA bookings, 0037 confirming an expired booking that was paid, 0038 the receiving account's QR receiver, 0039 the landscape).
 * All must be there.
 */
const LATEST_PROBES: { table: string; contains?: string }[] = [
  { table: "error_events" },
  { table: "booking_tarps" },
  { table: "bookings", contains: "substr(booking_code, 1, 3)" },
  { table: "payment_settings" },
  { table: "email_logs" },
  { table: "admin_menu_hidden" },
  { table: "bookings", contains: "deposit_satang" },
  { table: "booking_items", contains: "pay_later_satang" },
  { table: "credit_account" },
  { table: "bookings", contains: "app_fee_satang" },
  { table: "credit_settings", contains: "qr_receiver" },
  { table: "trg_user_roles_super_admin_grant" },
  { table: "center_nonces" },
  { table: "center_sso_tickets" },
  { table: "site_suspension" },
  { table: "trg_camping_night_closed" },
  { table: "ical_feeds" },
  { table: "channex_unit_map" },
  { table: "channex_ari_state" },
  { table: "ota_bookings" },
  { table: "trg_bookings_credit_reinstate" },
  { table: "receiving_accounts", contains: "qr_receiver" },
  { table: "landscape_layouts" },
  { table: "landscape_palette", contains: "look TEXT" },
  { table: "trg_booking_items_unit_change" },
  { table: "booking_extra_beds" },
  { table: "booking_pets" },
  { table: "booking_move_requests" },
  { table: "media_assets", contains: "focal_x" },
  { table: "extra_bed_unit_off" },
  { table: "media_assets", contains: "zoom INTEGER" },
  { table: "pricing_settings", contains: "pay_now_percent" },
  { table: "booking_massages" },
];
/** The cron runs every minute; 5 minutes without a finished run means it stopped. */
export const CRON_STALE_MS = 5 * 60_000;

const migrationNumber = (name: string) => Number(/^(\d{4})_/.exec(name)?.[1] ?? NaN);

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Liveness for uptime monitors: database, schema version, cron freshness. Exposes no configuration. */
  async check(): Promise<HealthDto> {
    const dbOk = await this.repository.pingDatabase();
    let schema: HealthDto["schema"] = "unknown";
    let cron: HealthDto["cron"] = "unknown";
    if (dbOk) {
      const latest = await this.repository.latestMigration();
      if (typeof latest === "string") schema = migrationNumber(latest) >= migrationNumber(LATEST_MIGRATION) ? "ok" : "outdated";
      else if (latest === null) schema = "outdated";
      else {
        const found = await Promise.all(LATEST_PROBES.map((p) => this.repository.hasTable(p.table, p.contains)));
        schema = found.includes(undefined) ? "unknown" : found.every(Boolean) ? "ok" : "outdated";
      }
      const last = await this.repository.cronLastRun();
      if (last) cron = this.now().getTime() - new Date(last).getTime() <= CRON_STALE_MS ? "ok" : "stale";
    }
    const degraded = !dbOk || schema === "outdated" || cron === "stale";
    return { status: degraded ? "degraded" : "ok", database: dbOk ? "ok" : "unavailable", schema, cron, time: this.now().toISOString() };
  }
}
