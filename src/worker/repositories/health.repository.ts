import type { D1DatabaseLike } from "../env.ts";

export interface HealthRepository {
  pingDatabase(): Promise<boolean>;
}

export class D1HealthRepository implements HealthRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async pingDatabase(): Promise<boolean> {
    try {
      const row = await this.db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return row?.ok === 1;
    } catch {
      return false;
    }
  }
}
