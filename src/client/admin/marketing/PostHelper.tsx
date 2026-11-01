import { useEffect, useState, type FormEvent } from "react";
import { POST_CHANNELS, POST_NOTE_MAX, POST_OFFER_MAX, type PostChannel, type PostDraftDto, type QuietDatesDto } from "../../../shared/ai-post-types.ts";
import { addDays } from "../../../shared/dates.ts";
import { aiMarketingMessages } from "../../../shared/i18n/ai-marketing-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage } from "../ui.tsx";

/**
 * AI post helper (Module C): pick quiet dates (suggested from the calendar), a channel and a language; the AI writes
 * three versions with a tracked booking link. Nothing is posted or sent — staff edit and copy the one they like.
 */
export function PostHelper({ initial }: { initial?: { from?: string; to?: string } }) {
  const { t, locale } = useAdmin();
  const m = aiMarketingMessages(locale.code).post;
  const date = (iso: string) => new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  const [quiet, setQuiet] = useState<QuietDatesDto | null>(null);
  const [channel, setChannel] = useState<PostChannel>("FACEBOOK");
  const [lang, setLang] = useState<LocaleCode>("th");
  const [from, setFrom] = useState(initial?.from ?? "");
  const [to, setTo] = useState(initial?.to ?? "");
  const [unitId, setUnitId] = useState("");
  const [offer, setOffer] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PostDraftDto | null>(null);
  const [texts, setTexts] = useState<string[]>([]);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<QuietDatesDto>(`/api/admin/ai-marketing/quiet-dates?lang=${encodeURIComponent(locale.code)}`, controller.signal)
      .then(setQuiet)
      .catch(() => undefined);
    return () => controller.abort();
  }, [locale.code]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<PostDraftDto>("POST", "/api/admin/ai-marketing/post-drafts", {
        channel, lang, ...(from && to ? { from, to } : {}), ...(unitId ? { unitId } : {}),
        ...(offer.trim() ? { offer: offer.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      });
      setResult(r);
      setTexts(r.variants.map((v) => v.text));
      setCopied(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(code === "AI_OFF" ? m.off : code === "AI_BUDGET_REACHED" ? m.budget : code === "TOO_MANY_REQUESTS" ? m.tooMany
        : code === "AI_FAILED" ? m.failed : err instanceof ApiError && err.details.to === "INVALID_RANGE" ? m.badRange : errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(i: number) {
    try {
      await navigator.clipboard.writeText(texts[i] ?? "");
      setCopied(i);
    } catch {
      setCopied(null);
    }
  }

  return (
    <section className="adm-card aim-post" aria-labelledby="aim-post-h" data-testid="aim-post">
      <h2 className="adm-h2" id="aim-post-h">{m.title}</h2>
      <p className="adm-small adm-muted">{m.intro}</p>

      {quiet && (
        <div className="aim-post__quiet">
          <p className="adm-small"><strong>{m.quietTitle}</strong></p>
          {quiet.quietRuns.length === 0 ? <p className="adm-small adm-muted">{m.noQuiet}</p> : (
            <div className="aim-post__chips">
              {quiet.quietRuns.slice(0, 6).map((q) => (
                <button key={q.from} type="button" className="aim-chip" aria-pressed={from === q.from && to === q.to}
                  onClick={() => { setFrom(q.from); setTo(q.to); }}>
                  {date(q.from)} – {date(q.to)} · {format(m.nights, { n: q.nights })}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <div className="adm-grid2">
          <div className="adm-field">
            <label htmlFor="post-channel">{m.channel}</label>
            <select id="post-channel" value={channel} onChange={(e) => setChannel(e.target.value as PostChannel)}>
              {POST_CHANNELS.map((c) => <option key={c} value={c}>{m[c]}</option>)}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="post-lang">{m.lang}</label>
            <select id="post-lang" value={lang} onChange={(e) => setLang(e.target.value as LocaleCode)}>
              {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="post-from">{m.from}</label>
            <input id="post-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value ? addDays(e.target.value, 1) : ""); }} />
          </div>
          <div className="adm-field">
            <label htmlFor="post-to">{m.to}</label>
            <input id="post-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="adm-field">
            <label htmlFor="post-unit">{m.unit}</label>
            <select id="post-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">{m.allUnits}</option>
              {quiet?.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="post-offer">{m.offer}</label>
            <input id="post-offer" value={offer} maxLength={POST_OFFER_MAX} placeholder={m.offerPlaceholder} onChange={(e) => setOffer(e.target.value)} />
            <p className="adm-field__hint">{m.offerHint}</p>
          </div>
        </div>
        <div className="adm-field">
          <label htmlFor="post-note">{m.note}</label>
          <input id="post-note" value={note} maxLength={POST_NOTE_MAX} placeholder={m.notePlaceholder} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button type="submit" busy={busy}>{busy ? m.working : m.button}</Button>
      </form>

      {error && <Alert kind="error">{error}</Alert>}
      {result && (
        <div className="aim-post__result" data-testid="aim-post-result">
          <p className="aim-ai__note">{format(m.done, { model: result.model })}</p>
          <p className="adm-small">{m.link} <code className="aim-post__link">{result.link}</code></p>
          <ol className="aim-post__variants">
            {texts.map((text, i) => (
              <li key={i}>
                <label className="aim-post__label" htmlFor={`post-v${i}`}>{format(m.variant, { n: i + 1 })}</label>
                <textarea id={`post-v${i}`} rows={Math.min(14, Math.max(5, text.split("\n").length + 1))} value={text}
                  onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))} />
                <div className="aim-post__actions">
                  <Button variant="secondary" onClick={() => void copy(i)}>{copied === i ? m.copied : m.copy}</Button>
                  <span className="adm-small adm-muted">{format(m.length, { n: text.length })}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
