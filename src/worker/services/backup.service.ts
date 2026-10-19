import type { D1DatabaseLike, R2BucketLike, R2ListedObjectLike } from "../env.ts";
import { randomToken } from "../security/tokens.ts";
import { iso, type Clock } from "./auth-context.ts";
import { LATEST_MIGRATION } from "./health.service.ts";

/**
 * Database backups (Center phase C8). The site's Worker dumps its own D1 into its own PRIVATE R2 bucket
 * (backups/<time>-<id>.sql.gz), so guest data never leaves the platform's Cloudflare account: no CI runner,
 * no laptop. Once a day from the cron, and on demand from Center. The newest BACKUP_KEEP files are kept.
 *
 * The file is plain SQL (gzip), in the same shape as `wrangler d1 export`: every table's CREATE, its rows as
 * INSERTs, then indexes, views and triggers (last, so they do not fire while rows go back in). Restore into a NEW,
 * EMPTY database: `gunzip -k f.sql.gz && npx wrangler d1 execute <new-db> --remote --file f.sql`.
 * Sessions, one-time links / tickets and Center nonces are left empty (nobody should be signed in by a restore).
 * The private bucket is never served by key (slips go through their own authorised routes), so backups/ is
 * reachable only through the signed Center API.
 */
export const BACKUP_PREFIX = "backups/";
export const BACKUP_KEEP = 30;
/** One backup a day (03:17 Bangkok = 20:17 UTC); skipped if the last one is younger than this. */
export const DAILY_BACKUP_MIN_AGE_MS = 20 * 3_600_000;
const NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[A-Za-z0-9_-]{6}\.sql\.gz$/;
const PAGE = 500;
/** Schema is kept, rows are not: sign-ins, one-time links and replay guards must not come back from a backup. */
const NO_ROWS = new Set(["sessions", "password_reset_tokens", "center_nonces", "center_sso_tickets"]);

export type BackupTrigger = "CRON" | "CENTER";

export interface BackupDto {
  name: string;
  size: number;
  createdAt: string;
  tables: number | null;
  rows: number | null;
  schema: string | null;
  trigger: string | null;
  sha256: string | null;
}

interface MasterRow { type: string; name: string; tbl_name: string; sql: string | null }

export class BackupService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly bucket: R2BucketLike,
    private readonly clock: Clock,
  ) {}

  static isName(name: string): boolean {
    return NAME.test(name);
  }

  /** The whole database as SQL text. */
  async dump(): Promise<{ sql: string; tables: number; rows: number }> {
    const { results } = await this.db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid")
      .all<MasterRow>();
    const tables = results.filter((r) => r.type === "table");
    const later = results.filter((r) => r.type === "index" || r.type === "view" || r.type === "trigger");
    const out: string[] = [];
    let rows = 0;
    out.push("PRAGMA defer_foreign_keys = TRUE;");
    for (const t of tables) {
      out.push(`${t.sql!.trim().replace(/;$/, "")};`);
      if (NO_ROWS.has(t.name)) continue;
      const columns = (await this.db.prepare(`PRAGMA table_info(${ident(t.name)})`).all<{ name: string }>()).results.map((c) => c.name);
      if (!columns.length) continue;
      const head = `INSERT INTO ${ident(t.name)} (${columns.map(ident).join(", ")}) VALUES `;
      const select = `SELECT rowid AS "__backup_rowid", ${columns.map(ident).join(", ")} FROM ${ident(t.name)} WHERE rowid > ?1 ORDER BY rowid LIMIT ${PAGE}`;
      let after = Number.MIN_SAFE_INTEGER;
      for (;;) {
        const page = (await this.db.prepare(select).bind(after).all<Record<string, unknown>>()).results;
        for (const row of page) {
          out.push(`${head}(${columns.map((c) => literal(row[c])).join(", ")});`);
          rows++;
        }
        if (page.length < PAGE) break;
        after = Number(page[page.length - 1]!.__backup_rowid);
      }
    }
    for (const o of later) out.push(`${o.sql!.trim().replace(/;$/, "")};`);
    return { sql: `${out.join("\n")}\n`, tables: tables.length, rows };
  }

  /** Dump, gzip and store; then drop the oldest beyond BACKUP_KEEP. */
  async create(trigger: BackupTrigger, site: string): Promise<BackupDto> {
    const now = this.clock();
    const { sql, tables, rows } = await this.dump();
    const header = `-- ${site} D1 backup ${iso(now)} · schema ${LATEST_MIGRATION} · ${tables} tables, ${rows} rows · ${trigger}\n`
      + "-- Restore into a NEW, EMPTY database: gunzip, then npx wrangler d1 execute <new-db> --remote --file <file>.sql\n";
    const gz = await gzip(header + sql);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", gz))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const name = `${iso(now).slice(0, 19).replace(/:/g, "-")}Z-${randomToken(6).slice(0, 6)}.sql.gz`;
    const meta = { tables: String(tables), rows: String(rows), schema: LATEST_MIGRATION, trigger, sha256 };
    await this.bucket.put(BACKUP_PREFIX + name, gz, { httpMetadata: { contentType: "application/gzip" }, customMetadata: meta });
    await this.prune();
    return { name, size: gz.byteLength, createdAt: iso(now), tables, rows, schema: LATEST_MIGRATION, trigger, sha256 };
  }

  /** Newest first. */
  async list(): Promise<BackupDto[]> {
    if (!this.bucket.list) return [];
    const all: R2ListedObjectLike[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: BACKUP_PREFIX, cursor, limit: 1000, include: ["customMetadata"] });
      all.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return all
      .map((o) => ({ o, name: o.key.slice(BACKUP_PREFIX.length) }))
      .filter((x) => NAME.test(x.name))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
      .map(({ o, name }) => ({
        name, size: o.size, createdAt: nameTime(name) ?? new Date(o.uploaded).toISOString(),
        tables: num(o.customMetadata?.tables), rows: num(o.customMetadata?.rows),
        schema: o.customMetadata?.schema ?? null, trigger: o.customMetadata?.trigger ?? null, sha256: o.customMetadata?.sha256 ?? null,
      }));
  }

  async open(name: string): Promise<{ body: ReadableStream; size: number } | null> {
    if (!NAME.test(name)) return null;
    return this.bucket.get(BACKUP_PREFIX + name);
  }

  /** The cron's daily backup: once a day, not again if a recent one exists (any trigger). */
  async daily(site: string): Promise<BackupDto | null> {
    const [latest] = await this.list();
    if (latest && this.clock().getTime() - new Date(latest.createdAt).getTime() < DAILY_BACKUP_MIN_AGE_MS) return null;
    return this.create("CRON", site);
  }

  private async prune(): Promise<void> {
    const old = (await this.list()).slice(BACKUP_KEEP);
    for (const b of old) await this.bucket.delete(BACKUP_PREFIX + b.name);
  }
}

/** "2026-10-19T10-35-27Z-abc123.sql.gz" → "2026-10-19T10:35:27.000Z". */
function nameTime(name: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z` : null;
}

function num(v: string | undefined): number | null {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : null;
}

/** A quoted SQL identifier ("a""b"). */
function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A value as an SQL literal. */
export function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;
  if (bytes) return `X'${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
