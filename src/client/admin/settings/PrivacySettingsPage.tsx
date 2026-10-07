import { useCallback, useEffect, useState, type FormEvent } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getAdminPrivacyMessages, type AdminPrivacyMessages } from "../../../shared/i18n/admin-privacy-messages.ts";
import { LOCALES, LOCALE_CODES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import { privacyPath } from "../../../shared/routes.ts";
import type { MarketingDto, MarketingEventDto, PrivacySettingsDto } from "../../../shared/settings-types.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { LangTabs } from "../cms/CmsKit.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, Field, fieldErrors, useDateFormatter } from "../ui.tsx";

type Msg = { kind: "error" | "success" | "info"; text: string } | null;
type Texts = PrivacySettingsDto["translations"];
const POLICY_MAX = 30_000;

export function useAdminPrivacyMessages(): AdminPrivacyMessages {
  const { locale } = useAdmin();
  return getAdminPrivacyMessages(locale.code);
}

/** Settings → Privacy (spec §46, `settings.privacy`): cookie banner, consent lifetime, policy texts. */
export function PrivacySettingsPage() {
  const { t, locale } = useAdmin();
  const pm = useAdminPrivacyMessages().privacy;
  const [data, setData] = useState<PrivacySettingsDto | null>(null);
  const [trackersOn, setTrackersOn] = useState<boolean | null>(null);
  const [bannerEnabled, setBannerEnabled] = useState(true);
  const [days, setDays] = useState("180");
  const [texts, setTexts] = useState<Texts>({});
  const [askAgain, setAskAgain] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lang, setLang] = useState<LocaleCode>("th");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback((d: PrivacySettingsDto) => {
    setData(d);
    setBannerEnabled(d.bannerEnabled);
    setDays(String(d.consentDays));
    setTexts(d.translations);
    setAskAgain(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<PrivacySettingsDto>("/api/admin/settings/privacy", controller.signal).then(load)
      .catch((err: unknown) => !controller.signal.aborted && setMsg({ kind: "error", text: detailMessage(t, err) }));
    // Whether a tracker is on (banner shown at all); only when this user may see Marketing.
    apiGet<MarketingDto>("/api/admin/settings/marketing", controller.signal)
      .then((m) => setTrackersOn((m.ga4Enabled && !!m.ga4MeasurementId) || (m.metaPixelEnabled && !!m.metaPixelId)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [t, load]);

  if (!data) return <section><h1 className="adm-h1">{pm.title}</h1>{msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <p role="status">{t.common.loading}</p>}</section>;

  const cur = texts[lang] ?? { bannerText: null, policyTitle: null, policyBody: null };
  const setText = (k: "bannerText" | "policyTitle" | "policyBody", v: string) => setTexts({ ...texts, [lang]: { ...cur, [k]: v } });
  const err = (k: string) => errors[`translations.${lang}.${k}`];
  const filled = (l: LocaleCode) => !!texts[l]?.policyBody?.trim();

  async function save() {
    setBusy(true);
    setMsg(null);
    setErrors({});
    // Only languages that changed (policies can be long).
    const changed = Object.fromEntries(LOCALE_CODES.filter((l) => JSON.stringify(texts[l] ?? null) !== JSON.stringify(data!.translations[l] ?? null))
      .map((l) => [l, { bannerText: texts[l]?.bannerText?.trim() || null, policyTitle: texts[l]?.policyTitle?.trim() || null, policyBody: texts[l]?.policyBody || null }]));
    try {
      load(await apiRequest<PrivacySettingsDto>("PUT", "/api/admin/settings/privacy", {
        bannerEnabled, consentDays: Number(days), askAgain, translations: changed,
      }));
      setMsg({ kind: "success", text: t.common.saved });
    } catch (e) {
      setErrors(fieldErrors(t, e));
      setMsg({ kind: "error", text: detailMessage(t, e) });
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (askAgain) setConfirming(true);
    else void save();
  };

  const policyLink = privacyPath(LOCALES.find((l) => l.code === lang) ?? locale);
  const hasAnyPolicy = LOCALE_CODES.some(filled);

  return (
    <section>
      <h1 className="adm-h1">{pm.title}</h1>
      <p className="adm-muted">{pm.intro}</p>
      {trackersOn === false && <Alert kind="info">{pm.noTrackers}</Alert>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={submit} noValidate>
        <fieldset className="adm-fieldset" disabled={busy}>
          <div className="adm-card">
            <h2 className="adm-h2">{pm.banner}</h2>
            <label className="adm-check">
              <input type="checkbox" checked={bannerEnabled} onChange={(e) => setBannerEnabled(e.currentTarget.checked)} />
              <span>{pm.bannerEnabled}</span>
            </label>
            {!bannerEnabled && <p className="adm-field__hint">{pm.bannerOffNote}</p>}
            <Field label={pm.days} type="number" inputMode="numeric" min={30} max={395} step={1} value={days} hint={pm.daysHint}
              error={errors.consentDays} onChange={(e) => setDays(e.currentTarget.value)} />
            <dl className="adm-dl">
              <dt>{pm.version}</dt><dd>{data.consentVersion}</dd>
            </dl>
            <label className="adm-check">
              <input type="checkbox" checked={askAgain} onChange={(e) => setAskAgain(e.currentTarget.checked)} aria-describedby="privacy-ask-hint" />
              <span>{pm.askAgain}</span>
            </label>
            <p id="privacy-ask-hint" className="adm-field__hint">{pm.askAgainHint}</p>
          </div>

          <div className="adm-card">
            <div className="adm-toolbar">
              <h2 className="adm-h2">{pm.texts}</h2>
              <LangTabs value={lang} onChange={setLang} filled={filled} />
            </div>
            <div className="adm-field">
              <label htmlFor="pv-banner">{pm.bannerText}</label>
              <textarea id="pv-banner" lang={lang} rows={3} maxLength={600} value={cur.bannerText ?? ""} onChange={(e) => setText("bannerText", e.currentTarget.value)} />
              {err("bannerText") && <p className="adm-field__error">{err("bannerText")}</p>}
            </div>
            <Field label={pm.policyTitle} lang={lang} maxLength={120} value={cur.policyTitle ?? ""} error={err("policyTitle")}
              onChange={(e) => setText("policyTitle", e.currentTarget.value)} />
            <div className="adm-field">
              <label htmlFor="pv-body">{pm.policyBody}</label>
              <textarea id="pv-body" lang={lang} rows={16} maxLength={POLICY_MAX} value={cur.policyBody ?? ""} aria-describedby="pv-body-hint"
                onChange={(e) => setText("policyBody", e.currentTarget.value)} />
              <p id="pv-body-hint" className="adm-field__hint">
                {pm.policyHint.replace("{lang}", LOCALES.find((l) => l.code === lang)?.path ?? lang)}{" "}
                {format(pm.chars, { n: (cur.policyBody ?? "").length, max: POLICY_MAX })}
              </p>
              {err("policyBody") && <p className="adm-field__error">{err("policyBody")}</p>}
            </div>
            {!hasAnyPolicy ? <Alert kind="info">{pm.policyEmpty}</Alert>
              : <p><a href={policyLink} target="_blank" rel="noopener">{pm.view}</a></p>}
          </div>
          <Button type="submit" busy={busy}>{t.common.save}</Button>
        </fieldset>
      </form>
      <ConfirmDialog open={confirming} message={pm.askAgainConfirm} confirmLabel={pm.askAgain}
        onConfirm={() => { setConfirming(false); void save(); }} onCancel={() => setConfirming(false)} />
    </section>
  );
}

/** Marketing → CAPI: Pixel source, test mode, "send test event" and the delivery log (no personal data). */
export function CapiPanel({ marketing }: { marketing: MarketingDto }) {
  const { t, can } = useAdmin();
  const cm = useAdminPrivacyMessages().capi;
  const dateTime = useDateFormatter();
  const [events, setEvents] = useState<MarketingEventDto[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<MarketingEventDto[]>("/api/admin/marketing/events", controller.signal).then(setEvents)
      .catch((err: unknown) => !controller.signal.aborted && setMsg({ kind: "error", text: detailMessage(t, err) }));
    return () => controller.abort();
  }, [t, version]);

  async function sendTest() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiRequest<MarketingEventDto>("POST", "/api/admin/marketing/capi-test", {});
      setMsg(r.status === "SENT" ? { kind: "success", text: cm.testSent }
        : { kind: "error", text: format(cm.testFailed, { error: r.lastError ?? (r.skipReason ? (cm.skip as Record<string, string>)[r.skipReason] ?? r.skipReason : "—") }) });
      setVersion((v) => v + 1);
    } catch (e) {
      setMsg({ kind: "error", text: detailMessage(t, e) });
    } finally {
      setBusy(false);
    }
  }

  const source = marketing.capiPixelSource === "SECRET" ? cm.fromSecret : marketing.capiPixelSource === "SETTINGS" ? cm.fromSettings : cm.noPixel;
  const canTest = can("marketing.edit") && marketing.capiTokenConfigured;
  return (
    <div className="adm-card" id="mkt-capi-log">
      <div className="adm-toolbar">
        <h2 className="adm-h2">{cm.title}</h2>
        <div className="adm-row">
          <Button variant="ghost" onClick={() => setVersion((v) => v + 1)}>{cm.refresh}</Button>
          {canTest && (
            <Button variant="secondary" busy={busy} disabled={!marketing.capiTestEventCodeConfigured} onClick={() => void sendTest()}
              aria-describedby={marketing.capiTestEventCodeConfigured ? undefined : "capi-test-hint"}>{cm.sendTest}</Button>
          )}
        </div>
      </div>
      <p className="adm-muted">{cm.intro}</p>
      {canTest && !marketing.capiTestEventCodeConfigured && <p id="capi-test-hint" className="adm-field__hint">{cm.testNeedsCode}</p>}
      <dl className="adm-dl">
        <dt>{cm.pixelSource}</dt><dd>{source}</dd>
      </dl>
      {marketing.capiPixelMismatch && <Alert kind="error">{cm.mismatch}</Alert>}
      {marketing.capiTestEventCodeConfigured && <Alert kind="info">{cm.testMode}</Alert>}
      <Alert kind="info">{cm.aamNote}</Alert>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{cm.cols.time}</th>
              <th scope="col">{cm.cols.event}</th>
              <th scope="col">{cm.cols.booking}</th>
              <th scope="col">{cm.cols.status}</th>
              <th scope="col">{cm.cols.attempts}</th>
              <th scope="col">{cm.cols.detail}</th>
            </tr>
          </thead>
          <tbody>
            {events === null && <tr><td colSpan={6} role="status">{t.common.loading}</td></tr>}
            {events?.length === 0 && <tr><td colSpan={6} className="adm-table__empty">{cm.empty}</td></tr>}
            {events?.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.createdAt)}</td>
                <td>{e.eventName}{e.isTest && <span className="adm-small adm-muted"> · {cm.test}</span>}</td>
                <td className="adm-mono">{e.bookingCode ?? "—"}</td>
                <td>{cm.status[e.status]}</td>
                <td>{e.attempts}</td>
                <td className="adm-small">
                  {e.status === "SENT" ? dateTime(e.sentAt) : e.skipReason ? (cm.skip as Record<string, string>)[e.skipReason] ?? e.skipReason : e.lastError ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
