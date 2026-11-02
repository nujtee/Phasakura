import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

/** A perk of the shared promotion list (migration 0056), with its names and how many price rules give it. */
export interface PromotionPerkRow {
  id: string;
  sort_order: number;
  status: "ACTIVE" | "INACTIVE";
  names: Record<string, string>;
  rule_count: number;
}

export class PromotionPerkRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** The list (active only unless asked), in order; empty before migration 0056. */
  async list(includeInactive = false): Promise<PromotionPerkRow[]> {
    type Row = { id: string; sort_order: number; status: "ACTIVE" | "INACTIVE"; rule_count: number; language_code: string | null; name: string | null };
    const rows = await withFallback(
      async () => (await this.db
        .prepare(`SELECT p.id, p.sort_order, p.status, t.language_code, t.name,
                         (SELECT count(*) FROM pricing_rule_perks rp JOIN pricing_settings s ON s.id = rp.rule_id AND s.status = 'ACTIVE'
                           WHERE rp.perk_id = p.id) AS rule_count
                    FROM promotion_perks p LEFT JOIN promotion_perk_translations t ON t.perk_id = p.id
                   WHERE (?1 = 1 OR p.status = 'ACTIVE')
                   ORDER BY p.sort_order, p.created_at, p.id`)
        .bind(includeInactive ? 1 : 0).all<Row>()).results,
      async () => [] as Row[],
    );
    const out: PromotionPerkRow[] = [];
    for (const r of rows) {
      let perk = out.find((x) => x.id === r.id);
      if (!perk) { perk = { id: r.id, sort_order: r.sort_order, status: r.status, names: {}, rule_count: r.rule_count }; out.push(perk); }
      if (r.language_code && r.name) perk.names[r.language_code] = r.name;
    }
    return out;
  }

  async nextSortOrder(): Promise<number> {
    const row = await this.db.prepare("SELECT coalesce(max(sort_order), 0) + 1 AS n FROM promotion_perks").first<{ n: number }>();
    return row?.n ?? 1;
  }

  insertStatement(id: string, sortOrder: number, now: string): D1PreparedStatementLike {
    return this.db.prepare("INSERT INTO promotion_perks (id, sort_order, status, created_at, updated_at) VALUES (?1, ?2, 'ACTIVE', ?3, ?3)")
      .bind(id, sortOrder, now);
  }

  /** Names: those given are written, languages left empty are removed (Thai is always given). */
  namesStatements(id: string, names: Record<string, string>, now: string): D1PreparedStatementLike[] {
    return [
      this.db.prepare("DELETE FROM promotion_perk_translations WHERE perk_id = ?1").bind(id),
      ...Object.entries(names).map(([lang, name]) =>
        this.db.prepare("INSERT INTO promotion_perk_translations (perk_id, language_code, name) VALUES (?1, ?2, ?3)").bind(id, lang, name)),
      this.db.prepare("UPDATE promotion_perks SET updated_at = ?2 WHERE id = ?1").bind(id, now),
    ];
  }

  /** Deleted: off every price rule and out of the list (kept INACTIVE: bookings keep their copy of the name). */
  removeStatements(id: string, now: string): D1PreparedStatementLike[] {
    return [
      this.db.prepare("DELETE FROM pricing_rule_perks WHERE perk_id = ?1").bind(id),
      this.db.prepare("UPDATE promotion_perks SET status = 'INACTIVE', updated_at = ?2 WHERE id = ?1").bind(id, now),
    ];
  }
}
