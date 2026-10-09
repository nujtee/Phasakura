import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { EmailLogDto, EmailRecipientDto, EmailSettingsDto } from "../../../shared/email-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getNotifyMessages } from "../../../shared/i18n/admin-notify-messages.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, errorMessage, Field, useDateFormatter } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";

type Msg = { kind: "error" | "success" | "info"; text: string } | null;
const TONE: Record<string, string> = { SENT: "active", PENDING: "warning", FAILED: "suspended", CANCELLED: "muted" };
const langLabel = (code: string) => LOCALES.find((l) => l.code === code)?.label ?? code;

/**
 * A log / test error code in words. Zoho codes carry details (ZOHO_AUTH_INVALID_CLIENT, ZOHO_401_…): the family
 * is explained and the exact code kept in brackets for support.
 */
export function emailReason(reasons: Record<string, string>, code: string | null): string | null {
  if (!code) return null;
  if (reasons[code]) return reasons[code]!;
  const family = /^ZOHO_AUTH_/.test(code) ? "ZOHO_AUTH"
    : /^ZOHO_(ACCOUNTS_)?401/.test(code) ? "ZOHO_SCOPE"
    : /^ZOHO_.*(LIMIT|TOO_?MANY|THROTTL)/.test(code) ? "ZOHO_LIMIT" : null;
  return family && reasons[family] ? `${reasons[family]} (${code})` : code;
}

function useNotify() {
  const { t, locale } = useAdmin();
  const all = getNotifyMessages(locale.code);
  const errs = all.errors as Record<string, string>;
  const lookup = (code: string) => errs[code] ?? (t.errors as Record<string, string>)[code];
  return {
    m: all.email,
    text(err: unknown): string {
      if (err instanceof ApiError) {
        for (const code of Object.values(err.details)) if (lookup(code)) return lookup(code)!;
        return lookup(err.code) ?? errorMessage(t, err);
      }
      return errorMessage(t, err);
    },
    fields(err: unknown): Record<string, string> {
      if (!(err instanceof ApiError)) return {};
      return Object.fromEntries(Object.entries(err.details).map(([k, code]) => [k, lookup(code) ?? t.errors.INVALID_FORMAT]));
    },
  };
}

/** Settings → E-mail notifications (Zoho Mail / Resend): sender, guest e-mails, staff addresses, recent e-mails. */
export function EmailPage() {
  const { can } = useAdmin();
  const { m } = useNotify();
  return (
    <section className="email-page">
      <h1 className="adm-h1">{m.title}</h1>
      <p className="adm-muted">{m.intro}</p>
      {can("settings.line") && <SettingsCard />}
      {can("settings.line") && <Recipients />}
      {can("notifications.view") && <Log />}
    </section>
  );
}

function SettingsCard() {
  const { t } = useAdmin();
  const { m, text, fields } = useNotify();
  const [s, setS] = useState<EmailSettingsDto | null>(null);
  const [f, setF] = useState({ enabled: false, guestEnabled: true, fromName: "", fromEmail: "", replyTo: "" });
  const [msg, setMsg] = useState<Msg>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const apply = (d: EmailSettingsDto) => {
    setS(d);
    setF({ enabled: d.enabled, guestEnabled: d.guestEnabled, fromName: d.fromName ?? "", fromEmail: d.fromEmail ?? "", replyTo: d.replyTo ?? "" });
  };
  useEffect(() => {
    apiGet<EmailSettingsDto>("/api/admin/email/settings").then(apply, (err: unknown) => setMsg({ kind: "error", text: text(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setFieldErr({});
    try {
      apply(await apiRequest<EmailSettingsDto>("PUT", "/api/admin/email/settings", {
        enabled: f.enabled, guestEnabled: f.guestEnabled,
        fromName: f.fromName.trim() || null, fromEmail: f.fromEmail.trim() || null, replyTo: f.replyTo.trim() || null,
      }));
      setMsg({ kind: "success", text: t.common.saved });
    } catch (err) {
      setFieldErr(fields(err));
      setMsg({ kind: "error", text: text(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!s) return msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <p role="status">{t.common.loading}</p>;
  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="adm-card">
        <h2 className="adm-h2">{m.providerTitle}</h2>
        <dl className="adm-dl">
          <dt>{m.provider}</dt>
          <dd>{s.provider ? <span className="adm-badge adm-badge--active">✓ {m[`provider${s.provider}`]}</span> : <span className="adm-badge adm-badge--suspended">{m.providerMissing}</span>}</dd>
        </dl>
        <p className="adm-field__hint">{s.provider === "RESEND" ? m.domainHint : m.zohoHint}</p>
      </div>
      <form className="adm-card" onSubmit={(e) => void save(e)} noValidate>
        <h2 className="adm-h2">{m.settingsTitle}</h2>
        <fieldset className="adm-fieldset" disabled={busy}>
          <label className="adm-check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.currentTarget.checked })} /><span>{m.enabled}</span></label>
          {fieldErr.enabled && <p className="adm-field__error">{fieldErr.enabled}</p>}
          <label className="adm-check"><input type="checkbox" checked={f.guestEnabled} onChange={(e) => setF({ ...f, guestEnabled: e.currentTarget.checked })} /><span>{m.guestEnabled}</span></label>
          <div className="adm-grid2">
            <Field label={m.fromEmail} hint={m.fromEmailHint} type="email" autoComplete="off" maxLength={254} value={f.fromEmail} error={fieldErr.fromEmail}
              onChange={(e) => setF({ ...f, fromEmail: e.currentTarget.value })} />
            {/* Zoho Mail sends with the mailbox's own name and has no Reply-To: these two only apply to Resend. */}
            {s.provider === "RESEND" && (
              <>
                <Field label={m.fromName} hint={m.fromNameHint} maxLength={80} value={f.fromName} error={fieldErr.fromName}
                  onChange={(e) => setF({ ...f, fromName: e.currentTarget.value })} />
                <Field label={m.replyTo} type="email" autoComplete="off" maxLength={254} value={f.replyTo} error={fieldErr.replyTo}
                  onChange={(e) => setF({ ...f, replyTo: e.currentTarget.value })} />
              </>
            )}
          </div>
          <Button type="submit" busy={busy}>{t.common.save}</Button>
        </fieldset>
      </form>
    </>
  );
}

function Recipients() {
  const { t, locale } = useAdmin();
  const { m, text, fields } = useNotify();
  const [list, setList] = useState<EmailRecipientDto[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<EmailRecipientDto | null>(null);
  const empty = { email: "", name: "", language: locale.code as LocaleCode, notifyBooking: true, notifyPayment: true };
  const [f, setF] = useState(empty);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    apiGet<EmailRecipientDto[]>("/api/admin/email/recipients").then(setList, (err: unknown) => setMsg({ kind: "error", text: text(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patch(r: EmailRecipientDto, change: Partial<EmailRecipientDto>) {
    const next = { ...r, ...change };
    setList((l) => l?.map((x) => (x.id === r.id ? next : x)) ?? null);
    setBusyId(r.id);
    setMsg(null);
    try {
      const saved = await apiRequest<EmailRecipientDto>("PATCH", `/api/admin/email/recipients/${r.id}`, {
        email: next.email, name: next.name, language: next.language, notifyBooking: next.notifyBooking, notifyPayment: next.notifyPayment, active: next.active,
      });
      setList((l) => l?.map((x) => (x.id === r.id ? saved : x)) ?? null);
    } catch (err) {
      setList((l) => l?.map((x) => (x.id === r.id ? r : x)) ?? null);
      setMsg({ kind: "error", text: text(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function test(r: EmailRecipientDto) {
    setBusyId(r.id);
    setMsg(null);
    try {
      const log = await apiRequest<EmailLogDto>("POST", `/api/admin/email/recipients/${r.id}/test`, {});
      setMsg(log.status === "SENT" ? { kind: "success", text: m.testSent } : { kind: "error", text: format(m.testFailed, { error: emailReason(m.reasons, log.lastError) ?? log.status }) });
    } catch (err) {
      setMsg({ kind: "error", text: text(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: EmailRecipientDto) {
    setRemoving(null);
    try {
      await apiRequest("DELETE", `/api/admin/email/recipients/${r.id}`);
      setList((l) => l?.filter((x) => x.id !== r.id) ?? null);
    } catch (err) {
      setMsg({ kind: "error", text: text(err) });
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setMsg(null);
    setFieldErr({});
    try {
      const r = await apiRequest<EmailRecipientDto>("POST", "/api/admin/email/recipients", { ...f, email: f.email.trim(), name: f.name.trim() });
      setList((l) => [...(l ?? []), r]);
      setF(empty);
      setMsg({ kind: "success", text: m.added });
    } catch (err) {
      setFieldErr(fields(err));
      setMsg({ kind: "error", text: text(err) });
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="adm-card">
      <h2 className="adm-h2">{m.recipientsTitle}</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!list ? <p role="status">{t.common.loading}</p> : (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{m.email}</th>
                <th scope="col">{m.language}</th>
                <th scope="col">{m.types}</th>
                <th scope="col">{m.active}</th>
                <th scope="col"><span className="visually-hidden">{m.test}</span></th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={5} className="adm-table__empty">{m.empty}</td></tr>}
              {list.map((r) => {
                const busy = busyId === r.id;
                return (
                  <tr key={r.id} className={r.active ? undefined : "line-row--off"}>
                    <td><strong>{r.name}</strong><div className="adm-small adm-mono">{r.email}</div></td>
                    <td>{langLabel(r.language)}</td>
                    <td>
                      <div className="line-types">
                        <label className="adm-check"><input type="checkbox" checked={r.notifyBooking} disabled={busy} onChange={(e) => void patch(r, { notifyBooking: e.currentTarget.checked })} /><span>{m.booking}</span></label>
                        <label className="adm-check"><input type="checkbox" checked={r.notifyPayment} disabled={busy} onChange={(e) => void patch(r, { notifyPayment: e.currentTarget.checked })} /><span>{m.payment}</span></label>
                      </div>
                    </td>
                    <td>
                      <label className="adm-check">
                        <input type="checkbox" checked={r.active} disabled={busy} onChange={(e) => void patch(r, { active: e.currentTarget.checked })} />
                        <span className="visually-hidden">{m.active}</span>
                      </label>
                    </td>
                    <td>
                      <div className="adm-row adm-row--wrap">
                        <Button variant="secondary" busy={busy} disabled={!r.active} onClick={() => void test(r)}>{m.test}</Button>
                        <Button variant="ghost" onClick={() => setRemoving(r)}>{m.remove}</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <form className="email-add" onSubmit={(e) => void add(e)} noValidate>
        <fieldset className="adm-fieldset" disabled={adding}>
          <div className="adm-grid2">
            <Field label={m.email} type="email" required autoComplete="off" maxLength={254} value={f.email} error={fieldErr.email}
              onChange={(e) => setF({ ...f, email: e.currentTarget.value })} />
            <Field label={m.name} required maxLength={80} value={f.name} error={fieldErr.name} onChange={(e) => setF({ ...f, name: e.currentTarget.value })} />
          </div>
          <div className="adm-row adm-row--wrap">
            <div className="adm-field">
              <label htmlFor="email-add-lang">{m.language}</label>
              <select id="email-add-lang" value={f.language} onChange={(e) => setF({ ...f, language: e.currentTarget.value as LocaleCode })}>
                {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
            <label className="adm-check"><input type="checkbox" checked={f.notifyBooking} onChange={(e) => setF({ ...f, notifyBooking: e.currentTarget.checked })} /><span>{m.booking}</span></label>
            <label className="adm-check"><input type="checkbox" checked={f.notifyPayment} onChange={(e) => setF({ ...f, notifyPayment: e.currentTarget.checked })} /><span>{m.payment}</span></label>
          </div>
          <Button type="submit" busy={adding} disabled={!f.email.trim() || !f.name.trim()}>{m.add}</Button>
        </fieldset>
      </form>
      <ConfirmDialog open={!!removing} danger confirmLabel={m.remove} message={removing ? format(m.removeConfirm, { email: removing.email }) : ""}
        onCancel={() => setRemoving(null)} onConfirm={() => removing && void remove(removing)} />
    </div>
  );
}

function Log() {
  const { t, can, href } = useAdmin();
  const { m, text } = useNotify();
  const dateTime = useDateFormatter();
  const [version, setVersion] = useState(0);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const buildUrl = useCallback((before: string | null) => {
    const p = new URLSearchParams({ limit: "30" });
    if (before) p.set("before", before);
    void version;
    return `/api/admin/email/logs?${p}`;
  }, [version]);
  const { items, cursor, loading, error, more } = useCursorList<EmailLogDto>(buildUrl);
  const reason = (code: string | null) => emailReason(m.reasons, code);

  async function retry(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      await apiRequest("POST", `/api/admin/email/logs/${id}/retry`, {});
      setVersion((v) => v + 1);
    } catch (err) {
      setMsg({ kind: "error", text: text(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="adm-card">
      <h2 className="adm-h2">{m.logTitle}</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{m.time}</th><th scope="col">{m.type}</th><th scope="col">{m.recipient}</th>
              <th scope="col">{m.bookingCol}</th><th scope="col">{m.status}</th>
              {can("settings.line") && <th scope="col"><span className="visually-hidden">{m.retry}</span></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && <tr><td colSpan={6} className="adm-table__empty">{m.logEmpty}</td></tr>}
            {items.map((e) => (
              <tr key={e.id}>
                <td className="adm-small">{dateTime(e.createdAt)}</td>
                <td>{m.typesLabel[e.type] ?? e.type}</td>
                <td>{e.audience === "GUEST" ? <span className="adm-badge adm-badge--muted">{m.guest}</span> : e.recipientName ?? "—"}</td>
                <td>{e.bookingCode ? <Link to={href("bookings", e.bookingCode)} className="adm-mono">{e.bookingCode}</Link> : "—"}</td>
                <td>
                  <span className={`adm-badge adm-badge--${TONE[e.status]}`}>{m.statuses[e.status]}</span>
                  {e.lastError && <div className="adm-small adm-muted line-reason">{reason(e.lastError)}</div>}
                </td>
                {can("settings.line") && (
                  <td>{(e.status === "FAILED" || e.status === "CANCELLED") && <Button variant="secondary" busy={busy === e.id} onClick={() => void retry(e.id)}>{m.retry}</Button>}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p role="status">{t.common.loading}</p>}
      {cursor && !loading && <div className="adm-pager"><Button variant="secondary" onClick={more}>{t.common.loadMore}</Button></div>}
    </div>
  );
}
