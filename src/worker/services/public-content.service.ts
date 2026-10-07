import type {
  PublicGalleryDto, PublicHistoryDto, PublicHomeDto, PublicImageDto, PublicSectionDto, PublicSlideDto,
} from "../../shared/content-types.ts";
import { DEFAULT_LOCALE_CODE, type LocaleCode } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike } from "../env.ts";
import { iso, type Clock } from "./auth-context.ts";
import { publicMediaUrl } from "./media-url.ts";

type Row = Record<string, unknown>;

/**
 * Read-only public content (spec §8–11, §59). Only PUBLISHED records (slides: inside their
 * schedule window) of PUBLISHED categories, only ACTIVE public images. Static SQL only.
 */
export class PublicContentService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly clock: Clock,
    private readonly mediaBaseUrl: string | undefined,
  ) {}

  async home(lang: LocaleCode): Promise<PublicHomeDto> {
    const now = iso(this.clock());
    const [slides, slideTr, sections, sectionTr] = await this.db.batch([
      this.db.prepare(
        `SELECT s.id, s.overlay_enabled, s.overlay_color, s.overlay_opacity, s.content_position, s.button1_url, s.button2_url,
                d.object_key AS d_key, d.width AS d_w, d.height AS d_h, m.object_key AS m_key, m.width AS m_w, m.height AS m_h
           FROM home_slides s
           JOIN media_assets d ON d.id = s.desktop_asset_id AND d.bucket = 'PUBLIC' AND d.status = 'ACTIVE'
           LEFT JOIN media_assets m ON m.id = s.mobile_asset_id AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE'
          WHERE s.status IN ('PUBLISHED', 'SCHEDULED')
            AND (s.start_at IS NULL OR s.start_at <= ?1) AND (s.end_at IS NULL OR s.end_at > ?1)
          ORDER BY s.sort_order, s.created_at LIMIT 20`,
      ).bind(now),
      this.db.prepare(
        `SELECT t.* FROM home_slide_translations t JOIN home_slides s ON s.id = t.slide_id
          WHERE s.status IN ('PUBLISHED', 'SCHEDULED')`,
      ),
      this.db.prepare(
        `SELECT s.id, s.section_type, m.object_key AS i_key, m.width AS i_w, m.height AS i_h
           FROM home_sections s LEFT JOIN media_assets m ON m.id = s.media_asset_id AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE'
          WHERE s.status = 'PUBLISHED' ORDER BY s.sort_order, s.created_at LIMIT 50`,
      ),
      this.db.prepare(
        `SELECT t.* FROM home_section_translations t JOIN home_sections s ON s.id = t.section_id WHERE s.status = 'PUBLISHED'`,
      ),
    ]);
    const st = byOwner(slideTr!.results as Row[], "slide_id");
    const sc = byOwner(sectionTr!.results as Row[], "section_id");
    return {
      language: lang,
      slides: (slides!.results as Row[]).map((r): PublicSlideDto => {
        const t = pick(st.get(r.id as string), lang);
        const alt = str(t.image_alt) ?? str(t.title) ?? "";
        return {
          id: r.id as string,
          desktop: this.image(r.d_key, r.d_w, r.d_h, alt)!,
          mobile: this.image(r.m_key, r.m_w, r.m_h, alt),
          overlay: { enabled: r.overlay_enabled === 1, color: r.overlay_color as string, opacity: r.overlay_opacity as number },
          position: r.content_position as string,
          title: str(t.title),
          subtitle: str(t.subtitle),
          description: str(t.description),
          button1: button(t.button1_label, r.button1_url),
          button2: button(t.button2_label, r.button2_url),
        };
      }).filter((s) => s.desktop),
      sections: (sections!.results as Row[]).map((r) => this.section(r, pick(sc.get(r.id as string), lang), null)),
    };
  }

  async gallery(lang: LocaleCode): Promise<PublicGalleryDto> {
    const [cats, catTr, images, imageTr] = await this.db.batch([
      this.db.prepare("SELECT id, slug FROM gallery_categories WHERE status = 'PUBLISHED' ORDER BY sort_order, slug"),
      this.db.prepare(
        `SELECT t.* FROM gallery_category_translations t JOIN gallery_categories c ON c.id = t.category_id WHERE c.status = 'PUBLISHED'`,
      ),
      this.db.prepare(
        `SELECT g.id, g.layout_span, c.slug, m.object_key AS i_key, m.width AS i_w, m.height AS i_h
           FROM gallery_images g
           JOIN media_assets m ON m.id = g.media_asset_id AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE'
           LEFT JOIN gallery_categories c ON c.id = g.category_id
          WHERE g.status = 'PUBLISHED' AND (g.category_id IS NULL OR c.status = 'PUBLISHED')
          ORDER BY g.sort_order, g.created_at LIMIT 500`,
      ),
      this.db.prepare(`SELECT t.* FROM gallery_image_translations t JOIN gallery_images g ON g.id = t.image_id WHERE g.status = 'PUBLISHED'`),
    ]);
    const ct = byOwner(catTr!.results as Row[], "category_id");
    const it = byOwner(imageTr!.results as Row[], "image_id");
    return {
      language: lang,
      categories: (cats!.results as Row[]).map((r) => {
        const t = pick(ct.get(r.id as string), lang);
        return { id: r.id as string, slug: r.slug as string, name: str(t.name) ?? (r.slug as string), description: str(t.description) };
      }),
      images: (images!.results as Row[]).map((r) => {
        const t = pick(it.get(r.id as string), lang);
        return {
          id: r.id as string,
          categorySlug: (r.slug as string | null) ?? null,
          span: r.layout_span as string,
          image: this.image(r.i_key, r.i_w, r.i_h, str(t.alt_text) ?? str(t.title) ?? "")!,
          title: str(t.title),
          caption: str(t.caption),
        };
      }),
    };
  }

  async history(lang: LocaleCode): Promise<PublicHistoryDto> {
    const [sections, sectionTr, timeline, timelineTr] = await this.db.batch([
      this.db.prepare(
        `SELECT s.id, s.section_type, s.layout, m.object_key AS i_key, m.width AS i_w, m.height AS i_h
           FROM history_sections s LEFT JOIN media_assets m ON m.id = s.media_asset_id AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE'
          WHERE s.status = 'PUBLISHED' ORDER BY s.sort_order, s.created_at LIMIT 100`,
      ),
      this.db.prepare(`SELECT t.* FROM history_translations t JOIN history_sections s ON s.id = t.section_id WHERE s.status = 'PUBLISHED'`),
      this.db.prepare(
        `SELECT h.id, h.year, m.object_key AS i_key, m.width AS i_w, m.height AS i_h
           FROM history_timeline h LEFT JOIN media_assets m ON m.id = h.media_asset_id AND m.bucket = 'PUBLIC' AND m.status = 'ACTIVE'
          WHERE h.status = 'PUBLISHED' ORDER BY h.sort_order, h.year LIMIT 200`,
      ),
      this.db.prepare(
        `SELECT t.* FROM history_timeline_translations t JOIN history_timeline h ON h.id = t.timeline_id WHERE h.status = 'PUBLISHED'`,
      ),
    ]);
    const sc = byOwner(sectionTr!.results as Row[], "section_id");
    const tt = byOwner(timelineTr!.results as Row[], "timeline_id");
    return {
      language: lang,
      sections: (sections!.results as Row[]).map((r) => this.section(r, pick(sc.get(r.id as string), lang), r.layout as string)),
      timeline: (timeline!.results as Row[]).flatMap((r) => {
        const t = pick(tt.get(r.id as string), lang);
        const title = str(t.title);
        if (!title) return [];
        return [{
          id: r.id as string, year: r.year as number, title, description: str(t.description),
          image: this.image(r.i_key, r.i_w, r.i_h, str(t.image_alt) ?? title),
        }];
      }),
    };
  }

  private section(r: Row, t: Row, layout: string | null): PublicSectionDto {
    return {
      id: r.id as string,
      type: r.section_type as string,
      image: this.image(r.i_key, r.i_w, r.i_h, str(t.image_alt) ?? str(t.title) ?? ""),
      layout,
      title: str(t.title),
      subtitle: str(t.subtitle),
      body: str(t.body),
      ...(t.quote_author !== undefined ? { quoteAuthor: str(t.quote_author) } : {}),
      button: button(t.button_label, t.button_url),
    };
  }

  private image(key: unknown, w: unknown, h: unknown, alt: string): PublicImageDto | null {
    const url = publicMediaUrl(key as string | null, this.mediaBaseUrl);
    return url ? { url, width: (w as number | null) ?? null, height: (h as number | null) ?? null, alt } : null;
  }
}

function byOwner(rows: Row[], fk: string): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const list = map.get(r[fk] as string) ?? [];
    list.push(r);
    map.set(r[fk] as string, list);
  }
  return map;
}

/** Requested language, else the default language (th). */
function pick(rows: Row[] | undefined, lang: LocaleCode): Row {
  return rows?.find((r) => r.language_code === lang) ?? rows?.find((r) => r.language_code === DEFAULT_LOCALE_CODE) ?? {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function button(label: unknown, url: unknown): { label: string; url: string } | null {
  const l = str(label);
  const u = str(url);
  return l && u ? { label: l, url: u } : null;
}
