import type { HealthDto } from "../../shared/system-types.ts";
import type { HealthRepository } from "../repositories/health.repository.ts";

/**
 * The newest migration this code expects (Phase 16). A test keeps it equal to the last file in
 * migrations/, so a deploy whose migrations were not applied shows up as `schema: "outdated"`.
 */
export const LATEST_MIGRATION = "0021_camping_tarp.sql";
/** Its newest table: the schema probe where D1's migration list cannot be read. */
const LATEST_TABLE = "booking_tarps";
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
        const has = await this.repository.hasTable(LATEST_TABLE);
        schema = has === undefined ? "unknown" : has ? "ok" : "outdated";
      }
      const last = await this.repository.cronLastRun();
      if (last) cron = this.now().getTime() - new Date(last).getTime() <= CRON_STALE_MS ? "ok" : "stale";
    }
    const degraded = !dbOk || schema === "outdated" || cron === "stale";
    return { status: degraded ? "degraded" : "ok", database: dbOk ? "ok" : "unavailable", schema, cron, time: this.now().toISOString() };
  }
}
