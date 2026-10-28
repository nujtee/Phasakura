import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getLandscapeMessages } from "../../../shared/i18n/admin-landscape-messages.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import {
  LANDSCAPE_BACKGROUNDS, LANDSCAPE_LIMITS,
  type LandscapeBackgroundKind, type LandscapeLayoutSummaryDto, type LandscapeOverviewDto, type LandscapeVersionDto,
} from "../../../shared/landscape-types.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Link } from "../../router/Router.tsx";
import { Alert, Button, ConfirmDialog, Field, errorMessage, useDateFormatter } from "../ui.tsx";

type Msg = { kind: "error" | "success" | "info"; text: string } | null;
type Confirm = { message: string; label: string; danger?: boolean; run: () => Promise<void> } | null;

/** Accommodation → Site plan (landscape, migration 0039): the switch, the plans, publishing and version history. */
export function LandscapePage() {
  const { t, can, locale, href } = useAdmin();
  const m = getLandscapeMessages(locale.code);
  const dateTime = useDateFormatter();
  const [data, setData] = useState<LandscapeOverviewDto | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LandscapeBackgroundKind>("BLANK");
  const [open, setOpen] = useState<string | null>(null);
  const [versions, setVersions] = useState<LandscapeVersionDto[] | null>(null);
  const [note, setNote] = useState("");

  const fail = useCallback((err: unknown) => {
    const code = err instanceof ApiError ? (Object.values(err.details ?? {}).find((c) => m.errors[c]) ?? err.code) : null;
    setMsg({ kind: "error", text: code && m.errors[code] ? m.errors[code] : errorMessage(t, err) });
  }, [m, t]);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<LandscapeOverviewDto>("/api/admin/landscape"));
    } catch (err) {
      fail(err);
    }
  }, [fail]);
  useEffect(() => void load(), [load]);

  const loadVersions = useCallback(async (id: string) => {
    setVersions(null);
    try {
      setVersions(await apiGet<LandscapeVersionDto[]>(`/api/admin/landscape/layouts/${encodeURIComponent(id)}/versions`));
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  if (!can("landscape.view")) return <Alert kind="error">{t.errors.FORBIDDEN}</Alert>;

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMsg(null);
    try {
      await action();
      await load();
      if (open) await loadVersions(open);
      if (done) setMsg({ kind: "success", text: done });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (enabled: boolean) => run(async () => setData(await apiRequest<LandscapeOverviewDto>("PUT", "/api/admin/landscape/settings", { enabled })));

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await apiRequest("POST", "/api/admin/landscape/layouts", { name: name.trim(), backgroundKind: kind });
      setName("");
    }, m.done.created);
  }

  const path = (l: LandscapeLayoutSummaryDto, rest = "") => `/api/admin/landscape/layouts/${encodeURIComponent(l.id)}${rest}`;
  const editable = !!data?.enabled;

  return (
    <section className="adm-landscape">
      <h1 className="adm-h1">{m.title}</h1>
      <p className="adm-muted">{m.intro}</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!data && !msg && <p role="status">{t.common.loading}</p>}
      {data && (
        <>
          <div className="adm-card">
            <h2 className="adm-h2">{m.switchTitle}</h2>
            <div className="adm-channels__switch">
              <div>
                <strong>{m.title}</strong>{" "}
                <span className={`adm-badge ${data.enabled ? "adm-badge--active" : "adm-badge--suspended"}`}>{data.enabled ? m.on : m.off}</span>
                <p className="adm-small adm-muted">{m.switchWhat}</p>
              </div>
              {data.canToggle
                ? (data.enabled
                  ? <Button variant="secondary" disabled={busy} onClick={() => setConfirm({ message: m.confirmOff, label: m.turnOff, danger: true, run: () => toggle(false) })}>{m.turnOff}</Button>
                  : <Button disabled={busy} busy={busy} onClick={() => void toggle(true)}>{m.turnOn}</Button>)
                : <p className="adm-small adm-muted">{m.onlySuperAdmin}</p>}
            </div>
          </div>

          {!data.enabled && <Alert kind="info">{m.offNotice}</Alert>}

          <div className="adm-card">
            <h2 className="adm-h2">{m.layouts}</h2>
            {data.layouts.length === 0 && <p className="adm-muted">{m.noLayouts}</p>}
            <ul className="adm-landscape__list">
              {data.layouts.map((l) => (
                <li key={l.id} className="adm-landscape__item">
                  <div className="adm-landscape__head">
                    <strong>{l.name}</strong>
                    <span className="adm-badge adm-badge--muted">{m.bgShort[l.backgroundKind]}</span>
                    {l.isPublic && <span className="adm-badge adm-badge--active">{m.onBookingPage}</span>}
                    {l.unpublishedChanges && l.publishedVersionNo !== null && <span className="adm-badge adm-badge--warning">{m.unpublished}</span>}
                  </div>
                  <p className="adm-small adm-muted">
                    {format(m.revision, { n: l.draftRevision })} · {format(m.savedBy, { time: dateTime(l.draftUpdatedAt), name: l.draftUpdatedBy ?? "—" })} · {" "}
                    {l.publishedVersionNo !== null ? format(m.published, { n: l.publishedVersionNo }) : m.notPublished}
                  </p>
                  <div className="adm-row adm-row--wrap">
                    <Link className="adm-btn adm-btn--secondary" to={href("landscape", l.id)}>{m.editor.open}</Link>
                    {editable && data.canPublish && (
                      <Button disabled={busy} onClick={() => setConfirm({
                        message: m.publishConfirm, label: m.publish,
                        run: () => run(() => apiRequest("POST", path(l, "/publish"), { revision: l.draftRevision, note: note.trim() || undefined, makePublic: false }), m.done.published),
                      })}>{m.publish}</Button>
                    )}
                    {editable && data.canPublish && l.publishedVersionNo !== null && (
                      l.isPublic
                        ? <Button variant="secondary" disabled={busy} onClick={() => void run(() => apiRequest("PUT", "/api/admin/landscape/public", { layoutId: null }), m.done.public)}>{m.hideFromBooking}</Button>
                        : <Button variant="secondary" disabled={busy} onClick={() => void run(() => apiRequest("PUT", "/api/admin/landscape/public", { layoutId: l.id }), m.done.public)}>{m.showOnBooking}</Button>
                    )}
                    <Button variant="secondary" disabled={busy} aria-expanded={open === l.id} onClick={() => {
                      const next = open === l.id ? null : l.id;
                      setOpen(next);
                      if (next) void loadVersions(next);
                    }}>{m.versions}</Button>
                    {editable && data.canPublish && (
                      <Button variant="ghost" disabled={busy} onClick={() => setConfirm({
                        message: format(m.archiveConfirm, { name: l.name }), label: m.archive, danger: true,
                        run: () => run(() => apiRequest("DELETE", path(l)), m.done.archived),
                      })}>{m.archive}</Button>
                    )}
                  </div>
                  {open === l.id && (
                    <div className="adm-subform">
                      {editable && data.canPublish && (
                        <Field label={m.publishNote} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                      )}
                      <h3 className="adm-h3">{m.versions}</h3>
                      {!versions && <p role="status">{t.common.loading}</p>}
                      {versions?.length === 0 && <p className="adm-muted">{m.notPublished}</p>}
                      <ul className="adm-landscape__versions">
                        {versions?.map((v) => (
                          <li key={v.id}>
                            <span>{format(m.versionRow, { n: v.versionNo, time: dateTime(v.publishedAt), by: v.publishedBy ? ` · ${v.publishedBy}` : "", objects: v.objects })}</span>
                            {v.restoredFromNo !== null && <span className="adm-muted"> {format(m.restoredFrom, { n: v.restoredFromNo })}</span>}
                            {v.note && <span className="adm-muted"> — {v.note}</span>}
                            {editable && (
                              <span className="adm-row adm-row--wrap">
                                {data.canPublish && v.versionNo !== l.publishedVersionNo && (
                                  <Button variant="secondary" disabled={busy} onClick={() => setConfirm({
                                    message: format(m.republishConfirm, { n: v.versionNo }), label: m.republish,
                                    run: () => run(() => apiRequest("POST", path(l, `/versions/${encodeURIComponent(v.id)}/republish`)), m.done.published),
                                  })}>{m.republish}</Button>
                                )}
                                {data.canEdit && (
                                  <Button variant="ghost" disabled={busy} onClick={() => setConfirm({
                                    message: format(m.restoreConfirm, { n: v.versionNo }), label: m.restore, danger: true,
                                    run: () => run(() => apiRequest("POST", path(l, `/versions/${encodeURIComponent(v.id)}/restore`), { baseRevision: l.draftRevision }), m.done.restored),
                                  })}>{m.restore}</Button>
                                )}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {editable && data.canEdit && (
            <form className="adm-card" onSubmit={(e) => void create(e)}>
              <h2 className="adm-h2">{m.newLayout}</h2>
              <Field label={m.name} required maxLength={LANDSCAPE_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />
              <fieldset className="adm-field">
                <legend className="adm-label">{m.background}</legend>
                {LANDSCAPE_BACKGROUNDS.map((b) => (
                  <label key={b} className="adm-check">
                    <input type="radio" name="landscape-bg" value={b} checked={kind === b} onChange={() => setKind(b)} /> {m.bg[b]}
                  </label>
                ))}
              </fieldset>
              <Button type="submit" busy={busy} disabled={!name.trim()}>{m.create}</Button>
            </form>
          )}
        </>
      )}
      <ConfirmDialog open={confirm !== null} danger={confirm?.danger} message={confirm?.message ?? ""} confirmLabel={confirm?.label ?? ""}
        onCancel={() => setConfirm(null)} onConfirm={() => { const c = confirm; setConfirm(null); if (c) void c.run(); }} />
    </section>
  );
}
