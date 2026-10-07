import { addDays, isIsoDate, todayIn } from "../../shared/dates.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale, type LocaleCode } from "../../shared/i18n/locales.ts";
import { getSearchMessages } from "../../shared/i18n/search-messages.ts";
import { accommodationPath, pagePath } from "../../shared/routes.ts";
import {
  normalizeSearchText, SEARCH_LIMITS, searchTokens,
  type SearchAnalyticsDto, type SearchEntityType, type SearchResponseDto, type SearchResultDto,
} from "../../shared/search-types.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ValidationError } from "../http/errors.ts";
import type { IndexDoc, SearchRepository } from "../repositories/search.repository.ts";
import { newId } from "../security/tokens.ts";
import type { AccommodationService } from "./accommodation.service.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { AvailabilityService } from "./availability.service.ts";
import type { PublicContentService } from "./public-content.service.ts";
import type { QuoteService } from "./quote.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

const TYPE_WEIGHT: Partial<Record<SearchEntityType, number>> = { HOUSE: 30, VIP_TENT: 30, CAMPING: 25, FOOD: 20, HISTORY: 10, GALLERY: 5 };
const SAFETY_REBUILD_MS = 24 * 60 * 60_000;
const HISTORY_RETENTION_DAYS = 90;
const TEXT_MAX = 4000;

const clip = (text: string | null | undefined, max = 200) => {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

type Hydrated = Omit<SearchResultDto, "availability">;

/**
 * Global search (spec §40–41). The index (search_index) is a projection rebuilt from the content
 * services, used only to find candidate records. Each candidate is then read again from the source
 * (published / active only), and with dates the availability is checked live — never from the index.
 */
export class SearchService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: SearchRepository,
    private readonly accommodation: AccommodationService,
    private readonly quotes: QuoteService,
    private readonly content: PublicContentService,
    private readonly availability: AvailabilityService,
    private readonly timezone: () => Promise<string | null>,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  // ================================================================ index

  /** Index documents for one language, from the same services the public pages use. */
  private async documents(locale: Locale): Promise<IndexDoc[]> {
    const lang = locale.code;
    const sm = getSearchMessages(lang);
    const [list, menu, gallery, history] = await Promise.all([
      this.accommodation.publicList(locale), this.quotes.publicMenu(lang), this.content.gallery(lang), this.content.history(lang),
    ]);
    const docs: IndexDoc[] = [];
    const add = (type: SearchEntityType, entityId: string, title: string, summary: string | null, keywords: string[], body: string[], url: string) => {
      const kw = [...keywords, (sm.keywords as Partial<Record<SearchEntityType, string>>)[type] ?? "", sm.types[type]].filter(Boolean).join(" ");
      docs.push({
        id: `${type}:${entityId}:${lang}`, type, entityId, lang, title, summary: clip(summary), keywords: clip(kw, 500), url,
        text: normalizeSearchText([title, summary ?? "", kw, ...body].join(" ")).slice(0, TEXT_MAX), boost: 0,
      });
    };
    for (const u of [...list.houses, ...list.vipTents]) {
      add(u.unitType === "HOUSE" ? "HOUSE" : "VIP_TENT", u.id, u.name, u.shortDescription ?? u.description,
        u.amenities.map((a) => a.name), [u.description ?? ""], accommodationPath(locale, u.slug));
    }
    if (list.camping.enabled) {
      add("CAMPING", "camping", list.camping.name ?? sm.types.CAMPING, list.camping.description, [], [], `${pagePath(locale, "booking")}#sec-camping`);
    }
    for (const c of menu.categories) {
      for (const o of c.options) {
        add("FOOD", o.id, o.name, o.description, [c.name, o.allergens ?? ""], [], pagePath(locale, "booking"));
      }
    }
    for (const s of history.sections) {
      const title = s.title ?? clip(s.body, 60);
      if (!title) continue;
      add("HISTORY", `s:${s.id}`, title, s.subtitle ?? s.body, [], [s.body ?? "", s.quoteAuthor ?? ""], `${pagePath(locale, "history")}#hs-${s.id}`);
    }
    for (const i of history.timeline) {
      add("HISTORY", `t:${i.id}`, i.title, i.description, [String(i.year), String(i.year + 543)], [], pagePath(locale, "history"));
    }
    const categories = new Map(gallery.categories.map((c) => [c.slug, c.name]));
    for (const g of gallery.images) {
      const title = g.title ?? (g.image.alt || null);
      if (!title) continue;
      add("GALLERY", g.id, title, g.caption, [g.categorySlug ? categories.get(g.categorySlug) ?? "" : ""], [g.image.alt], pagePath(locale, "gallery"));
    }
    return docs;
  }

  /** Rebuilds the whole index in one atomic batch. */
  async rebuild(fingerprint?: string): Promise<number> {
    const fp = fingerprint ?? (await this.repo.fingerprint());
    const docs = (await Promise.all(LOCALES.map((l) => this.documents(l)))).flat();
    await this.db.batch([
      ...this.repo.replaceStatements(docs, fp, iso(this.clock())),
      this.repo.purgeHistoryStatement(iso(new Date(this.clock().getTime() - HISTORY_RETENTION_DAYS * 86_400_000))),
    ]);
    return docs.length;
  }

  /** Cron: rebuild only when content changed (or once a day as a safety net). */
  async rebuildIfStale(): Promise<number | null> {
    const [fp, state] = await Promise.all([this.repo.fingerprint(), this.repo.state()]);
    const old = state ? this.clock().getTime() - new Date(state.rebuilt_at).getTime() > SAFETY_REBUILD_MS : true;
    if (state && state.fingerprint === fp && !old) return null;
    return this.rebuild(fp);
  }

  // ================================================================ search

  async search(input: { q: string | null; lang: Locale; checkIn: string | null; checkOut: string | null; guests: number | null }): Promise<SearchResponseDto> {
    const q = (input.q ?? "").trim().slice(0, SEARCH_LIMITS.maxQueryLength);
    const tokens = searchTokens(q);
    const hasDates = input.checkIn !== null || input.checkOut !== null;
    if (hasDates && (!isIsoDate(input.checkIn) || !isIsoDate(input.checkOut))) throw new ValidationError({ checkIn: "INVALID_DATE" });
    if (!hasDates && normalizeSearchText(q).length < 2) throw new ValidationError({ q: "TOO_SHORT" });
    const locale = input.lang;
    const lang = locale.code;

    // A never-built index is built on first use (fresh installs); afterwards the cron keeps it current.
    if (tokens.length && !(await this.repo.state())) await this.rebuild();

    // Candidates: with words, the index; with dates only, every accommodation.
    type Candidate = { type: SearchEntityType; entityId: string; score: number };
    const candidates = new Map<string, Candidate>();
    if (tokens.length) {
      const phrase = normalizeSearchText(q);
      for (const row of await this.repo.match(tokens, 400)) {
        const title = normalizeSearchText(row.title);
        const score = (TYPE_WEIGHT[row.entity_type] ?? 0) + row.boost
          + (tokens.every((t) => title.includes(t)) ? 50 : 0) + (title.includes(phrase) ? 30 : 0) + (title.startsWith(phrase) ? 10 : 0)
          + (row.language_code === lang ? 10 : 0);
        const key = `${row.entity_type}:${row.entity_id}`;
        const prev = candidates.get(key);
        if (!prev || prev.score < score) candidates.set(key, { type: row.entity_type, entityId: row.entity_id, score });
      }
    }

    const hydrated = await this.hydrate(locale, [...candidates.values()].map((c) => `${c.type}:${c.entityId}`), !tokens.length && hasDates);
    let results: (SearchResultDto & { score: number })[] = [];
    for (const [key, h] of hydrated) {
      results.push({ ...h, availability: null, score: candidates.get(key)?.score ?? TYPE_WEIGHT[h.type] ?? 0 });
    }

    if (hasDates) {
      const live = await this.availability.publicAvailability({
        checkIn: input.checkIn!, checkOut: input.checkOut!, ...(input.guests ? { guests: input.guests } : {}),
      });
      const units = new Map(live.units.map((u) => [u.unitId, u.available && u.fitsGuests]));
      results = results.map((r) => {
        if (r.type === "HOUSE" || r.type === "VIP_TENT") {
          const available = units.get(r.id) ?? false;
          return { ...r, availability: { available, remaining: null }, score: r.score + (available ? 40 : 0) };
        }
        if (r.type === "CAMPING") {
          const available = live.camping.enabled && live.camping.remaining > 0;
          return { ...r, availability: { available, remaining: live.camping.enabled ? live.camping.remaining : 0 }, score: r.score + (available ? 40 : 0) };
        }
        return r;
      });
    }

    results.sort((a, b) => b.score - a.score || (a.price?.satang ?? 0) - (b.price?.satang ?? 0) || a.title.localeCompare(b.title, lang));
    const out = results.slice(0, SEARCH_LIMITS.maxResults).map(({ score: _score, ...r }) => r);

    // Analytics: no IP, no user; failures never break the search.
    if (q) {
      const now = this.clock();
      const day = todayIn((await this.timezone()) ?? "Asia/Bangkok", now);
      await this.db.batch(this.repo.logStatements({
        id: newId(), query: q, normalized: normalizeSearchText(q).slice(0, 200), lang, checkIn: input.checkIn, checkOut: input.checkOut,
        results: out.length, day, now: iso(now),
      })).catch(() => undefined);
    }

    return { query: q, lang, checkIn: input.checkIn, checkOut: input.checkOut, results: out };
  }

  /** Re-reads candidates from the public services in the visitor's language; anything no longer public drops out. */
  private async hydrate(locale: Locale, keys: string[], allAccommodation: boolean): Promise<Map<string, Hydrated>> {
    const lang = locale.code;
    const types = new Set(keys.map((k) => k.split(":")[0] as SearchEntityType));
    const needUnits = allAccommodation || types.has("HOUSE") || types.has("VIP_TENT") || types.has("CAMPING");
    const [list, menu, gallery, history] = await Promise.all([
      needUnits ? this.accommodation.publicList(locale) : null,
      types.has("FOOD") ? this.quotes.publicMenu(lang) : null,
      types.has("GALLERY") ? this.content.gallery(lang) : null,
      types.has("HISTORY") ? this.content.history(lang) : null,
    ]);
    const sm = getSearchMessages(lang);
    const out = new Map<string, Hydrated>();
    const img = (i: { url: string; alt: string; width: number | null; height: number | null; srcset?: string | null } | null | undefined) =>
      i ? { url: i.url, srcset: i.srcset ?? null, alt: i.alt, width: i.width, height: i.height } : null;
    if (list) {
      for (const u of [...list.houses, ...list.vipTents]) {
        const type: SearchEntityType = u.unitType === "HOUSE" ? "HOUSE" : "VIP_TENT";
        out.set(`${type}:${u.id}`, {
          type, id: u.id, title: u.name, summary: clip(u.shortDescription ?? u.description), url: accommodationPath(locale, u.slug),
          image: img(u.cover), price: { satang: u.priceSatang, per: "NIGHT" },
        });
      }
      if (list.camping.enabled) {
        out.set("CAMPING:camping", {
          type: "CAMPING", id: "camping", title: list.camping.name ?? sm.types.CAMPING, summary: clip(list.camping.description),
          url: `${pagePath(locale, "booking")}#sec-camping`, image: img(list.camping.cover),
          price: { satang: list.camping.pricePerAdultNightSatang, per: "ADULT_NIGHT" },
        });
      }
    }
    if (menu) {
      const per = { PER_PERSON: "PERSON", PER_SET: "SET", PER_ITEM: "ITEM", PER_NIGHT: "NIGHT" } as const;
      for (const c of menu.categories) {
        for (const o of c.options) {
          out.set(`FOOD:${o.id}`, {
            type: "FOOD", id: o.id, title: o.name, summary: clip(o.description) ?? c.name, url: pagePath(locale, "booking"),
            image: img(o.image), price: { satang: o.priceSatang, per: per[o.pricingType] },
          });
        }
      }
    }
    if (gallery) {
      for (const g of gallery.images) {
        const title = g.title ?? (g.image.alt || null);
        if (title) out.set(`GALLERY:${g.id}`, { type: "GALLERY", id: g.id, title, summary: clip(g.caption), url: pagePath(locale, "gallery"), image: img(g.image), price: null });
      }
    }
    if (history) {
      for (const s of history.sections) {
        const title = s.title ?? clip(s.body, 60);
        if (title) {
          out.set(`HISTORY:s:${s.id}`, {
            type: "HISTORY", id: `s:${s.id}`, title, summary: clip(s.subtitle ?? s.body), url: `${pagePath(locale, "history")}#hs-${s.id}`, image: img(s.image), price: null,
          });
        }
      }
      for (const i of history.timeline) {
        out.set(`HISTORY:t:${i.id}`, {
          type: "HISTORY", id: `t:${i.id}`, title: `${lang === "th" ? i.year + 543 : i.year} · ${i.title}`, summary: clip(i.description),
          url: pagePath(locale, "history"), image: img(i.image), price: null,
        });
      }
    }
    if (allAccommodation) {
      return new Map([...out].filter(([k]) => /^(HOUSE|VIP_TENT|CAMPING):/.test(k)));
    }
    const wanted = new Set(keys);
    return new Map([...out].filter(([k]) => wanted.has(k)));
  }

  /** A result was opened (counts toward that query's click-through). */
  async click(q: string, lang: LocaleCode): Promise<void> {
    const normalized = normalizeSearchText(q.slice(0, SEARCH_LIMITS.maxQueryLength)).slice(0, 200);
    if (!normalized) return;
    const day = todayIn((await this.timezone()) ?? "Asia/Bangkok", this.clock());
    await this.repo.click(normalized, lang, day);
  }

  // ================================================================ admin

  async analytics(actor: AuthContext, days: number, meta: RequestMeta): Promise<SearchAnalyticsDto> {
    await this.authz.requirePermission(actor, "seo.edit", meta);
    const today = todayIn((await this.timezone()) ?? "Asia/Bangkok", this.clock());
    const [data, state] = await Promise.all([this.repo.analytics(addDays(today, -(days - 1))), this.repo.state()]);
    const code = (l: string): LocaleCode => (LOCALES.find((x) => x.code === l) ?? DEFAULT_LOCALE).code;
    return {
      days,
      index: { rows: state?.rows_count ?? 0, rebuiltAt: state?.rebuilt_at ?? null },
      top: data.top.map((r) => ({ query: r.query_normalized, language: code(r.language_code), searches: r.searches, zeroResults: r.zero, clicks: r.clicks })),
      zeroResults: data.zero.map((r) => ({ query: r.query_normalized, language: code(r.language_code), searches: r.searches })),
    };
  }

  async reindex(actor: AuthContext, meta: RequestMeta): Promise<{ rows: number }> {
    await this.authz.requirePermission(actor, "seo.edit", meta);
    const rows = await this.rebuild();
    await this.log.auditStatement(actor.userId, "REBUILD_SEARCH_INDEX", "search", null, null, { rows }, meta).run();
    return { rows };
  }
}

