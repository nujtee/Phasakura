import { useCallback, useEffect, useState } from "react";
import { ICAL_CHANNEL_NAMES, type ChannelsDto, type IcalFeedDto } from "../../../shared/channel-types.ts";
import { getChannelMessages, type AdminChannelMessages } from "../../../shared/i18n/admin-channel-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, errorMessage, useDateFormatter } from "../ui.tsx";

type Msg = { kind: "error" | "success" | "info"; text: string } | null;
type Confirm = { message: string; label: string; danger?: boolean; run: () => Promise<void> } | null;

function useTexts(): AdminChannelMessages {
  const { locale } = useAdmin();
  return getChannelMessages(locale.code);
}

/** Accommodation → OTA channels (migration 0033): the on / off switch and iCal links per unit and OTA. */
export function ChannelsPage() {
  const { t, can, locale } = useAdmin();
  const m = useTexts();
  const [data, setData] = useState<ChannelsDto | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const fail = useCallback((err: unknown) => {
    const code = err instanceof ApiError ? (Object.values(err.details ?? {})[0] ?? err.code) : null;
    const known = m.errors as Record<string, string>;
    setMsg({ kind: "error", text: code && known[code] ? known[code] : errorMessage(t, err) });
  }, [m, t]);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<ChannelsDto>("/api/admin/channels"));
    } catch (err) {
      fail(err);
    }
  }, [fail]);
  useEffect(() => void load(), [load]);

  if (!can("channels.view")) return <Alert kind="error">{t.errors.FORBIDDEN}</Alert>;

  const toggle = async (ical: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      setData(await apiRequest<ChannelsDto>("PUT", "/api/admin/channels/settings", { ical }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const units = data ? [...new Map(data.ical.feeds.map((f) => [f.unitId, f])).values()] : [];

  return (
    <section className="adm-channels">
      <h1 className="adm-h1">{m.title}</h1>
      <p className="adm-muted">{m.intro}</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!data && !msg && <p role="status">{t.common.loading}</p>}
      {data && (
        <>
          <div className="adm-card">
            <h2 className="adm-h2">{m.switches}</h2>
            <div className="adm-channels__switch">
              <div>
                <strong>{m.icalName}</strong>{" "}
                <span className={`adm-badge ${data.ical.enabled ? "adm-badge--active" : "adm-badge--suspended"}`}>{data.ical.enabled ? m.on : m.off}</span>
                <p className="adm-small adm-muted">{m.icalWhat}</p>
              </div>
              {data.canToggle && (data.ical.enabled
                ? <Button variant="secondary" disabled={busy} onClick={() => setConfirm({ message: m.confirmOff, label: m.turnOff, danger: true, run: () => toggle(false) })}>{m.turnOff}</Button>
                : <Button disabled={busy} busy={busy} onClick={() => void toggle(true)}>{m.turnOn}</Button>)}
            </div>
            <div className="adm-channels__switch">
              <div>
                <strong>{m.channexName}</strong>{" "}
                <span className="adm-badge adm-badge--suspended">{m.off}</span>
                <p className="adm-small adm-muted">{m.channexSoon}</p>
              </div>
            </div>
            {!data.canToggle && <p className="adm-field__hint">{m.toggleNote}</p>}
          </div>

          {!data.ical.enabled && <Alert kind="info">{m.offNote}</Alert>}

          {data.ical.enabled && data.ical.conflicts.length > 0 && (
            <div className="adm-alert adm-alert--error" role="alert">
              <strong>{m.conflictsTitle}</strong>
              <ul>
                {data.ical.conflicts.map((c) => (
                  <li key={`${c.unitId}|${c.channel}|${c.date}`}>
                    {format(m.conflictRow, { unit: c.unitCode, channel: ICAL_CHANNEL_NAMES[c.channel], date: c.date, code: c.bookingCode ?? "—" })}
                  </li>
                ))}
              </ul>
              <p className="adm-small">{m.conflictHelp}</p>
            </div>
          )}

          {data.ical.enabled && (
            <>
              <details className="adm-card">
                <summary><strong>{m.howTitle}</strong></summary>
                <ol className="adm-channels__how">{m.how.map((line) => <li key={line}>{line}</li>)}</ol>
              </details>
              {units.map((u) => (
                <div key={u.unitId} className="adm-card adm-channels__unit">
                  <h2 className="adm-h2">
                    {u.names[locale.code] ?? u.names.th ?? u.unitCode} <span className="adm-small adm-muted">{u.unitCode} · {u.unitType === "HOUSE" ? m.unitHouse : m.unitTent}</span>
                  </h2>
                  {data.ical.feeds.filter((f) => f.unitId === u.unitId).map((f) => (
                    <FeedRow key={f.channel} feed={f} canEdit={data.canEdit} onChange={load} setMsg={setMsg} fail={fail} setConfirm={setConfirm} />
                  ))}
                </div>
              ))}
            </>
          )}
        </>
      )}
      <ConfirmDialog open={confirm !== null} message={confirm?.message ?? ""} confirmLabel={confirm?.label ?? ""} danger={confirm?.danger}
        onCancel={() => setConfirm(null)} onConfirm={() => { const c = confirm; setConfirm(null); void c?.run(); }} />
    </section>
  );
}

function FeedRow({ feed, canEdit, onChange, setMsg, fail, setConfirm }: {
  feed: IcalFeedDto; canEdit: boolean; onChange: () => Promise<void>;
  setMsg: (m: Msg) => void; fail: (err: unknown) => void; setConfirm: (c: Confirm) => void;
}) {
  const m = useTexts();
  const date = useDateFormatter();
  const channel = ICAL_CHANNEL_NAMES[feed.channel];
  const [url, setUrl] = useState(feed.importUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setUrl(feed.importUrl ?? ""), [feed.importUrl]);
  const base = `/api/admin/channels/ical/${encodeURIComponent(feed.unitId)}/${feed.channel}`;
  const id = `${feed.unitId}-${feed.channel}`;

  const run = async (call: () => Promise<IcalFeedDto>, done: (f: IcalFeedDto) => string) => {
    setBusy(true);
    setMsg(null);
    try {
      const f = await call();
      await onChange();
      setMsg({ kind: "success", text: done(f) });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const status = !feed.importSet ? m.statusNever
    : feed.lastImportStatus === "ERROR" ? format(m.statusError, { time: date(feed.lastImportAt), error: importError(m, feed.lastImportError) })
      : feed.lastImportAt ? format(m.statusOk, { time: date(feed.lastImportAt), n: feed.importedNights }) : "…";

  return (
    <div className="adm-channels__feed">
      <h3 className="adm-h3">{channel}</h3>
      {feed.exportUrl && (
        <div className="adm-field">
          <label htmlFor={`exp-${id}`}>{format(m.exportLabel, { channel })}</label>
          <div className="adm-row adm-row--wrap">
            <input id={`exp-${id}`} readOnly value={feed.exportUrl} onFocus={(e) => e.currentTarget.select()} className="adm-channels__url" />
            <Button variant="secondary" onClick={async () => {
              try { await navigator.clipboard.writeText(feed.exportUrl!); setCopied(true); } catch { setCopied(false); }
            }}>{copied ? m.copied : m.copy}</Button>
            {canEdit && (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirm({
                message: format(m.confirmRotate, { channel }), label: m.rotate, danger: true,
                run: () => run(() => apiRequest<IcalFeedDto>("POST", `${base}/rotate`, {}), () => format(m.rotated, { channel })),
              })}>{m.rotate}</Button>
            )}
          </div>
          <p className="adm-field__hint">{m.exportHint} · {feed.lastExportAt ? format(m.lastRead, { channel, time: date(feed.lastExportAt) }) : format(m.neverRead, { channel })}</p>
        </div>
      )}
      <form className="adm-field" onSubmit={(e) => {
        e.preventDefault();
        void run(() => apiRequest<IcalFeedDto>("PUT", base, { importUrl: url.trim() || null }),
          (f) => f.lastImportStatus === "ERROR" ? format(m.statusError, { time: date(f.lastImportAt), error: importError(m, f.lastImportError) }) : format(m.saved, { n: f.importedNights, channel }));
      }}>
        <label htmlFor={`imp-${id}`}>{format(m.importLabel, { channel })}</label>
        <div className="adm-row adm-row--wrap">
          <input id={`imp-${id}`} type="url" inputMode="url" value={url} placeholder={m.importPlaceholder} maxLength={2000}
            disabled={!canEdit} onChange={(e) => setUrl(e.currentTarget.value)} className="adm-channels__url" />
          {canEdit && <Button type="submit" disabled={busy || !url.trim() || url.trim() === (feed.importUrl ?? "")} busy={busy}>{m.save}</Button>}
          {canEdit && feed.importSet && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => apiRequest<IcalFeedDto>("POST", `${base}/sync`, {}),
                (f) => f.lastImportStatus === "ERROR" ? format(m.statusError, { time: date(f.lastImportAt), error: importError(m, f.lastImportError) }) : m.synced)}>{m.syncNow}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirm({
                message: format(m.confirmRemove, { channel, n: feed.importedNights }), label: m.remove, danger: true,
                run: () => run(() => apiRequest<IcalFeedDto>("PUT", base, { importUrl: null }), () => m.removed),
              })}>{m.remove}</Button>
            </>
          )}
        </div>
        <p className={`adm-field__hint${feed.lastImportStatus === "ERROR" ? " adm-channels__error" : ""}`} role="status">{m.status}: {status}</p>
      </form>
    </div>
  );
}

function importError(m: AdminChannelMessages, code: string | null): string {
  if (!code) return "—";
  const http = /^HTTP_(\d{3})$/.exec(code);
  if (http) return format(m.importErrors.HTTP, { code: http[1]! });
  return (m.importErrors as Record<string, string>)[code] ?? code;
}
