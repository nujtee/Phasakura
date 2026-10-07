import type { TranslationCoverageDto, TranslationKind } from "../../shared/seo-types.ts";
import type { D1DatabaseLike } from "../env.ts";
import type { AuthContext, RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";

interface KindDef {
  kind: TranslationKind;
  /** Base table, translation table, its key column, the text columns that make up "translated". */
  table: string;
  tt: string;
  fk: string;
  text: string[];
  label: string;
  /** Only content visitors can see is reported. */
  where: string;
}

// Static configuration only — nothing user-controlled reaches the SQL text.
const KINDS: KindDef[] = [
  { kind: "accommodation", table: "accommodation_units", tt: "accommodation_translations", fk: "unit_id", text: ["name"], label: "name", where: "e.status = 'ACTIVE'" },
  { kind: "amenity", table: "amenities", tt: "amenity_translations", fk: "amenity_id", text: ["name"], label: "name", where: "e.status = 'ACTIVE'" },
  { kind: "foodCategory", table: "food_categories", tt: "food_category_translations", fk: "food_category_id", text: ["name"], label: "name", where: "e.status = 'ACTIVE'" },
  { kind: "foodOption", table: "food_options", tt: "food_option_translations", fk: "food_option_id", text: ["name"], label: "name", where: "e.status = 'ACTIVE'" },
  { kind: "homeSlide", table: "home_slides", tt: "home_slide_translations", fk: "slide_id", text: ["title", "subtitle", "description", "image_alt"], label: "title", where: "e.status = 'PUBLISHED'" },
  { kind: "homeSection", table: "home_sections", tt: "home_section_translations", fk: "section_id", text: ["title", "subtitle", "body"], label: "title", where: "e.status = 'PUBLISHED'" },
  { kind: "galleryCategory", table: "gallery_categories", tt: "gallery_category_translations", fk: "category_id", text: ["name"], label: "name", where: "e.status = 'PUBLISHED'" },
  { kind: "galleryImage", table: "gallery_images", tt: "gallery_image_translations", fk: "image_id", text: ["alt_text", "title", "caption"], label: "coalesce(t.title, t.alt_text)", where: "e.status = 'PUBLISHED'" },
  { kind: "historySection", table: "history_sections", tt: "history_translations", fk: "section_id", text: ["title", "subtitle", "body"], label: "title", where: "e.status = 'PUBLISHED'" },
  { kind: "historyTimeline", table: "history_timeline", tt: "history_timeline_translations", fk: "timeline_id", text: ["title"], label: "title", where: "e.status = 'PUBLISHED'" },
];

const ITEM_LIMIT = 20;

function textOf(alias: string, cols: string[]): string {
  return `trim(${cols.map((c) => `coalesce(${alias}.${c}, '')`).join(" || ")})`;
}

/**
 * Which visible content is still Thai-only (Phase 13, i18n): a record counts as missing a language
 * when its Thai text exists and that language has none, so visitors see the Thai fallback.
 */
export class TranslationCoverageService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly authz: AuthorizationService,
  ) {}

  async coverage(actor: AuthContext, meta: RequestMeta): Promise<TranslationCoverageDto> {
    await this.authz.requirePermission(actor, "content.view", meta);
    const has = (tt: string, fk: string, cols: string[], lang: string) =>
      `EXISTS (SELECT 1 FROM ${tt} x WHERE x.${fk} = e.id AND x.language_code = '${lang}' AND ${textOf("x", cols)} <> '')`;
    const statements = KINDS.map((k) => this.db.prepare(
      `SELECT e.id AS id, ${k.label.includes("(") ? k.label : `t.${k.label}`} AS label,
              ${has(k.tt, k.fk, k.text, "en")} AS en, ${has(k.tt, k.fk, k.text, "zh-CN")} AS zh
         FROM ${k.table} e JOIN ${k.tt} t ON t.${k.fk} = e.id AND t.language_code = 'th' AND ${textOf("t", k.text)} <> ''
        WHERE ${k.where}
        ORDER BY label`,
    ));
    // Singletons: website texts, camping (when offered), floating booking button label, SEO texts per page.
    statements.push(
      this.db.prepare(
        `SELECT 'website' AS id, th.site_name AS label,
                EXISTS (SELECT 1 FROM site_setting_translations x WHERE x.language_code = 'en' AND trim(coalesce(x.site_name, '') || coalesce(x.tagline, '')) <> '') AS en,
                EXISTS (SELECT 1 FROM site_setting_translations x WHERE x.language_code = 'zh-CN' AND trim(coalesce(x.site_name, '') || coalesce(x.tagline, '')) <> '') AS zh
           FROM site_setting_translations th WHERE th.language_code = 'th' AND trim(coalesce(th.site_name, '') || coalesce(th.tagline, '')) <> ''
         UNION ALL
         SELECT 'camping', th.name,
                EXISTS (SELECT 1 FROM camping_setting_translations x WHERE x.language_code = 'en' AND trim(x.name) <> ''),
                EXISTS (SELECT 1 FROM camping_setting_translations x WHERE x.language_code = 'zh-CN' AND trim(x.name) <> '')
           FROM camping_setting_translations th JOIN camping_settings c ON c.id = 1 AND c.is_enabled = 1
          WHERE th.language_code = 'th'
         UNION ALL
         SELECT 'bookingCta', th.label,
                EXISTS (SELECT 1 FROM booking_cta_translations x WHERE x.language_code = 'en' AND trim(x.label) <> ''),
                EXISTS (SELECT 1 FROM booking_cta_translations x WHERE x.language_code = 'zh-CN' AND trim(x.label) <> '')
           FROM booking_cta_translations th JOIN booking_cta_settings c ON c.id = 1 AND c.enabled = 1
          WHERE th.language_code = 'th'`,
      ),
      this.db.prepare(
        `SELECT th.page_key AS id, th.page_key AS label,
                EXISTS (SELECT 1 FROM seo_settings x WHERE x.page_key = th.page_key AND x.language_code = 'en'
                          AND trim(coalesce(x.seo_title, '') || coalesce(x.meta_description, '')) <> '') AS en,
                EXISTS (SELECT 1 FROM seo_settings x WHERE x.page_key = th.page_key AND x.language_code = 'zh-CN'
                          AND trim(coalesce(x.seo_title, '') || coalesce(x.meta_description, '')) <> '') AS zh
           FROM seo_settings th WHERE th.language_code = 'th' AND trim(coalesce(th.seo_title, '') || coalesce(th.meta_description, '')) <> ''
          ORDER BY th.page_key`,
      ),
    );
    const results = await this.db.batch(statements);
    type Row = { id: string; label: string | null; en: number; zh: number };
    const kinds = [...KINDS.map((k) => k.kind), "settings", "seo"] as TranslationKind[];
    return {
      kinds: kinds.map((kind, i) => {
        const rows = (results[i]?.results ?? []) as Row[];
        const missing = rows.filter((r) => !r.en || !r.zh);
        return {
          kind,
          total: rows.length,
          missing: { en: rows.filter((r) => !r.en).length, "zh-CN": rows.filter((r) => !r.zh).length },
          items: missing.slice(0, ITEM_LIMIT).map((r) => ({
            id: r.id, label: r.label ?? r.id, missing: [...(r.en ? [] : ["en" as const]), ...(r.zh ? [] : ["zh-CN" as const])],
          })),
        };
      }),
    };
  }
}
