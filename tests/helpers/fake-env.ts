import type { D1DatabaseLike, D1PreparedStatementLike, D1Result, Env, R2BucketLike, R2ObjectBodyLike } from "../../src/worker/env.ts";

type Responder = (sql: string, params: unknown[]) => unknown[];

/**
 * In-memory fake of the D1 subset we use. `respond` returns rows for a statement,
 * or throws to simulate D1 errors (e.g. "no such table").
 */
export class FakeD1 implements D1DatabaseLike {
  readonly executed: { sql: string; params: unknown[] }[] = [];

  constructor(private readonly respond: Responder) {}

  prepare(sql: string): D1PreparedStatementLike {
    return new FakeStatement(this, sql, []);
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1Result<unknown>[]> {
    // D1 batches are atomic: if one fails, the whole batch rejects.
    return statements.map((s) => (s as FakeStatement).execute());
  }

  run(sql: string, params: unknown[]): unknown[] {
    this.executed.push({ sql, params });
    return this.respond(sql, params);
  }
}

class FakeStatement implements D1PreparedStatementLike {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new FakeStatement(this.db, this.sql, values);
  }

  execute(): D1Result<unknown> {
    return { results: this.db.run(this.sql, this.params), success: true };
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

export function missingTables(): FakeD1 {
  return new FakeD1((sql) => {
    if (/SELECT 1/.test(sql)) return [{ ok: 1 }];
    const table = /FROM\s+(\w+)/i.exec(sql)?.[1] ?? "unknown";
    throw new Error(`D1_ERROR: no such table: ${table}: SQLITE_ERROR`);
  });
}

export interface SeedSite {
  defaultLanguage?: string;
  translations?: { language_code: string; site_name: string | null; tagline: string | null }[];
  branding?: Record<string, string | number | null> | null;
}

export function seededSite(seed: SeedSite): FakeD1 {
  return new FakeD1((sql) => {
    if (/SELECT 1/.test(sql)) return [{ ok: 1 }];
    if (/FROM site_settings/.test(sql)) return [{ default_language: seed.defaultLanguage ?? "th" }];
    if (/FROM site_setting_translations/.test(sql)) return seed.translations ?? [];
    if (/FROM branding_settings/.test(sql)) return seed.branding ? [seed.branding] : [];
    if (/FROM theme_settings|FROM booking_cta_settings|FROM booking_cta_translations/.test(sql)) return [];
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });
}

/** In-memory R2 bucket (the subset we use). */
export class MemoryBucket implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Blob([o.bytes as BlobPart]).stream(), size: o.bytes.length };
  }

  async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
    return { key };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function makeEnv(db: D1DatabaseLike, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    MEDIA_PUBLIC: new MemoryBucket(),
    MEDIA_PRIVATE: new MemoryBucket(),
    ASSETS: { fetch: async () => new Response("<!doctype html><title>asset</title>", { status: 200 }) },
    APP_ENV: "development",
    ...overrides,
  };
}
