import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1DatabaseLike, D1PreparedStatementLike, D1Result } from "../../src/worker/env.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const MIGRATIONS_DIR = join(ROOT, "migrations");
export const DEV_SEED_FILE = join(ROOT, "seeds", "dev.sql");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

/**
 * SQLite database behaving like D1 for our purposes:
 * - foreign keys enforced (D1 default)
 * - batch() runs atomically in one transaction and rolls back on any error
 */
export class SqliteD1 implements D1DatabaseLike {
  readonly raw: DatabaseSync;

  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON;");
  }

  static migrated(options: { seed?: boolean } = {}): SqliteD1 {
    const db = new SqliteD1();
    for (const file of migrationFiles()) db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    if (options.seed) db.exec(readFileSync(DEV_SEED_FILE, "utf8"));
    return db;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteStatement(this.raw, sql, []);
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1Result<unknown>[]> {
    this.raw.exec("BEGIN");
    try {
      const results = statements.map((s) => (s as SqliteStatement).execute());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  /** Synchronous helpers for tests. */
  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.raw.prepare(sql).run(...params);
  }
}

class SqliteStatement implements D1PreparedStatementLike {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteStatement(this.db, this.sql, values);
  }

  execute(): D1Result<unknown> {
    const stmt = this.db.prepare(this.sql);
    const params = this.params as SQLInputValue[];
    if (stmt.columns().length > 0) return { results: stmt.all(...params), success: true };
    const info = stmt.run(...params);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.execute().results[0] as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>;
  }

  async run(): Promise<unknown> {
    return this.execute();
  }
}
