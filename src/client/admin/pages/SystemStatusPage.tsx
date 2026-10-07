import { useEffect, useState } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getAdminSystemMessages } from "../../../shared/i18n/admin-system-messages.ts";
import type { SystemCheckDto, SystemStatusDto } from "../../../shared/system-types.ts";
import { apiGet } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, useDateFormatter } from "../ui.tsx";

const ORDER: Record<SystemCheckDto["level"], number> = { error: 0, warning: 1, ok: 2 };
const BADGE: Record<SystemCheckDto["level"], string> = { ok: "adm-badge--active", warning: "adm-badge--warning", error: "adm-badge--error" };

/** Admin → System status (Phase 16, `system.view`): readiness checks, health, background jobs, errors. */
export function SystemStatusPage() {
  const { t, locale } = useAdmin();
  const m = getAdminSystemMessages(locale.code);
  const dateTime = useDateFormatter();
  const [data, setData] = useState<SystemStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    apiGet<SystemStatusDto>("/api/admin/system", controller.signal).then(setData)
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [t, version]);

  const level = (l: SystemCheckDto["level"]) => <span className={`adm-badge ${BADGE[l]}`}>{m.levels[l]}</span>;
  const count = (l: SystemCheckDto["level"]) => data?.checks.filter((c) => c.level === l).length ?? 0;
  const sorted = data ? [...data.checks].sort((a, b) => ORDER[a.level] - ORDER[b.level]) : [];

  return (
    <section>
      <div className="adm-pagehead">
        <div>
          <h1 className="adm-h1">{m.title}</h1>
          <p className="adm-muted">{m.intro}</p>
        </div>
        <Button variant="secondary" onClick={() => setVersion((v) => v + 1)}>{m.refresh}</Button>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <p role="status">{t.common.loading}</p>}
      {data && (
        <>
          <div className="adm-card">
            <dl className="adm-dl">
              <dt>{m.environment}</dt><dd className="adm-mono">{data.environment}</dd>
              <dt>{m.baseUrl}</dt><dd className="adm-mono">{data.baseUrl ?? "—"}</dd>
              <dt>{m.health}</dt>
              <dd>
                {level(data.health.status === "ok" ? "ok" : "error")}{" "}
                <span className="adm-small adm-muted">
                  {m.healthParts.database}: {data.health.database} · {m.healthParts.schema}: {data.health.schema} · {m.healthParts.cron}: {data.health.cron}
                </span>
              </dd>
            </dl>
          </div>

          <div className="adm-card">
            <div className="adm-toolbar">
              <h2 className="adm-h2">{m.checks}</h2>
              <p className="adm-small adm-muted" role="status">{format(m.summary, { errors: count("error"), warnings: count("warning"), ok: count("ok") })}</p>
            </div>
            <div className="adm-tablewrap">
              <table className="adm-table sys-checks">
                <tbody>
                  {sorted.map((c) => (
                    <tr key={c.key}>
                      <td>{level(c.level)}</td>
                      <th scope="row">
                        {m.checkTexts[c.key].label}
                        {c.level !== "ok" && <div className="adm-small adm-muted sys-fix">{m.checkTexts[c.key].fix}</div>}
                        {/* Narrow screens: the value moves under the name (the value column is hidden there). */}
                        {c.value && <div className="adm-mono adm-small sys-value--inline">{c.value}</div>}
                      </th>
                      <td className="adm-mono adm-small sys-value">{c.value ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="adm-grid2 adm-grid2--gap">
            <div className="adm-card">
              <h2 className="adm-h2">{m.heartbeats}</h2>
              {data.heartbeats.length === 0 ? <p className="adm-muted">{m.noHeartbeat}</p> : (
                <dl className="adm-dl">
                  {data.heartbeats.map((b) => (
                    <div key={b.name} className="sys-beat">
                      <dt className="adm-mono">{b.name}</dt>
                      <dd>
                        {level(b.lastStatus === "OK" ? "ok" : "error")} {m.hb.lastRun} {dateTime(b.lastRunAt)}
                        <div className="adm-small adm-muted">{m.hb.duration} {b.durationMs} ms · {m.hb.runs} {b.runs}</div>
                        {b.lastStatus !== "OK" && <div className="adm-small adm-muted">{m.hb.lastOk}: {dateTime(b.lastOkAt)} — {b.lastError}</div>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            <div className="adm-card">
              <h2 className="adm-h2">{m.backlog}</h2>
              <dl className="adm-dl">
                {(Object.keys(m.bl) as (keyof typeof m.bl)[]).map((k) => (
                  <div key={k} className="sys-beat"><dt>{m.bl[k]}</dt><dd>{data.backlog[k]}</dd></div>
                ))}
              </dl>
            </div>
          </div>

          <div className="adm-card">
            <h2 className="adm-h2">{m.errors}</h2>
            <p className="adm-small adm-muted">{m.errorsNote}</p>
            {data.errors.length === 0 ? <p>{m.noErrors}</p> : (
              <div className="adm-tablewrap">
                <table className="adm-table">
                  <thead>
                    <tr><th scope="col">{m.er.time}</th><th scope="col">{m.er.source}</th><th scope="col">{m.er.path}</th><th scope="col">{m.er.message}</th><th scope="col">{m.er.request}</th></tr>
                  </thead>
                  <tbody>
                    {data.errors.map((e) => (
                      <tr key={e.id}>
                        <td>{dateTime(e.occurredAt)}</td>
                        <td>{e.source}</td>
                        <td className="adm-mono adm-small">{[e.method, e.path].filter(Boolean).join(" ") || "—"}</td>
                        <td className="adm-small">{e.errorName ? `${e.errorName}: ` : ""}{e.message}</td>
                        <td className="adm-mono adm-small">{e.requestId ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
