import { DEFAULT_LOCALE_CODE, LOCALE_CODES, type Locale, type LocaleCode } from "../../shared/i18n/locales.ts";
import type { PrivacySettingsDto, PublicPrivacyDto } from "../../shared/settings-types.ts";
import type { D1DatabaseLike } from "../env.ts";
import { Validator } from "../validation.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

type Body = Record<string, unknown>;

interface Row { banner_enabled: number; consent_version: number; consent_days: number; updated_at: string }
interface TextRow { language_code: string; banner_text: string | null; policy_title: string | null; policy_body: string | null; updated_at: string }

/**
 * Settings → Privacy (spec §46, `settings.privacy`): the cookie banner (on/off, how long a choice
 * lasts, "ask everyone again") and the privacy policy page text per language.
 */
export class PrivacyService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  private async load(): Promise<{ row: Row | null; texts: TextRow[] }> {
    const [r, t] = await this.db.batch([
      this.db.prepare("SELECT banner_enabled, consent_version, consent_days, updated_at FROM privacy_settings WHERE id = 1"),
      this.db.prepare("SELECT language_code, banner_text, policy_title, policy_body, updated_at FROM privacy_setting_translations"),
    ]);
    return { row: (r?.results[0] as Row | undefined) ?? null, texts: (t?.results ?? []) as TextRow[] };
  }

  private dto(row: Row | null, texts: TextRow[]): PrivacySettingsDto {
    return {
      bannerEnabled: (row?.banner_enabled ?? 1) === 1,
      consentVersion: row?.consent_version ?? 1,
      consentDays: row?.consent_days ?? 180,
      translations: Object.fromEntries(texts.map((t) => [t.language_code, {
        bannerText: t.banner_text, policyTitle: t.policy_title, policyBody: t.policy_body,
      }])),
      updatedAt: [row?.updated_at, ...texts.map((t) => t.updated_at)].filter((x): x is string => !!x).sort().at(-1) ?? null,
    };
  }

  async get(actor: AuthContext, meta: RequestMeta): Promise<PrivacySettingsDto> {
    await this.authz.requirePermission(actor, "settings.privacy", meta);
    const { row, texts } = await this.load();
    return this.dto(row, texts);
  }

  /** `askAgain: true` raises the consent version: every visitor sees the banner again. */
  async save(actor: AuthContext, body: Body, meta: RequestMeta): Promise<PrivacySettingsDto> {
    await this.authz.requirePermission(actor, "settings.privacy", meta);
    const v = new Validator(body).allowOnly(["bannerEnabled", "consentDays", "askAgain", "translations"]);
    const bannerEnabled = v.boolean("bannerEnabled", true);
    const askAgain = v.boolean("askAgain", false);
    const days = body.consentDays === undefined ? 180 : body.consentDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 30 || days > 395) v.errors.consentDays = "OUT_OF_RANGE";
    const raw = body.translations ?? {};
    const texts: { lang: LocaleCode; bannerText: string | null; policyTitle: string | null; policyBody: string | null }[] = [];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) v.errors.translations = "EXPECTED_OBJECT";
    else {
      for (const [lang, value] of Object.entries(raw as Body)) {
        if (!(LOCALE_CODES as readonly string[]).includes(lang)) { v.errors[`translations.${lang}`] = "UNKNOWN_LANGUAGE"; continue; }
        if (typeof value !== "object" || value === null || Array.isArray(value)) { v.errors[`translations.${lang}`] = "EXPECTED_OBJECT"; continue; }
        const e = new Validator(value as Body).allowOnly(["bannerText", "policyTitle", "policyBody"]);
        texts.push({
          lang: lang as LocaleCode,
          bannerText: e.string("bannerText", { max: 600 }) ?? null,
          policyTitle: e.string("policyTitle", { max: 120 }) ?? null,
          policyBody: e.string("policyBody", { max: 30000, raw: true })?.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() || null,
        });
        for (const [k, code] of Object.entries(e.errors)) v.errors[`translations.${lang}.${k}`] = code;
      }
    }
    v.assertValid();
    const before = await this.load();
    const now = iso(this.clock());
    const version = (before.row?.consent_version ?? 1) + (askAgain ? 1 : 0);
    const summary = (d: PrivacySettingsDto) => ({
      ...d, updatedAt: undefined,
      // Policy texts can be long: the audit keeps their length, not the text.
      translations: Object.fromEntries(Object.entries(d.translations).map(([l, t]) => [l, { ...t, policyBody: t?.policyBody ? `${t.policyBody.length} chars` : null }])),
    });
    const beforeDto = this.dto(before.row, before.texts);
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO privacy_settings (id, banner_enabled, consent_version, consent_days, updated_at, updated_by) VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET banner_enabled = excluded.banner_enabled, consent_version = excluded.consent_version,
           consent_days = excluded.consent_days, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).bind(bannerEnabled ? 1 : 0, version, days, now, actor.userId),
      ...texts.map((t) => this.db.prepare(
        `INSERT INTO privacy_setting_translations (language_code, banner_text, policy_title, policy_body, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (language_code) DO UPDATE SET banner_text = excluded.banner_text, policy_title = excluded.policy_title,
           policy_body = excluded.policy_body, updated_at = excluded.updated_at`,
      ).bind(t.lang, t.bannerText, t.policyTitle, t.policyBody, now)),
      this.log.auditStatement(actor.userId, askAgain ? "RENEW_CONSENT" : "UPDATE_PRIVACY", "privacy", "privacy_settings",
        summary(beforeDto), summary({ ...beforeDto, bannerEnabled, consentVersion: version, consentDays: days as number,
          translations: { ...beforeDto.translations, ...Object.fromEntries(texts.map((t) => [t.lang, { bannerText: t.bannerText, policyTitle: t.policyTitle, policyBody: t.policyBody }])) } }), meta),
    ]);
    const after = await this.load();
    return this.dto(after.row, after.texts);
  }

  /** The privacy policy page in the visitor's language (Thai fallback). */
  async publicPolicy(locale: Locale): Promise<PublicPrivacyDto> {
    const { texts } = await this.load();
    const has = (t: TextRow | undefined) => !!t?.policy_body?.trim();
    const own = texts.find((t) => t.language_code === locale.code);
    const th = texts.find((t) => t.language_code === DEFAULT_LOCALE_CODE);
    const t = has(own) ? own : has(th) ? th : undefined;
    return { language: locale.code, title: t?.policy_title?.trim() || null, body: t?.policy_body ?? null, updatedAt: t?.updated_at ?? null };
  }
}
