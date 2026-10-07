import { useCallback } from "react";
import type { AuditLogDto } from "../../../shared/auth-types.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, useDateFormatter } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";

export function AuditLogsPage() {
  const { t } = useAdmin();
  const formatDate = useDateFormatter();
  const buildUrl = useCallback((before: string | null) => {
    const p = new URLSearchParams({ limit: "50" });
    if (before) p.set("before", before);
    return `/api/admin/audit-logs?${p}`;
  }, []);
  const { items, cursor, loading, error, more } = useCursorList<AuditLogDto>(buildUrl);

  return (
    <section>
      <h1 className="adm-h1">{t.audit.title}</h1>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{t.events.time}</th>
              <th scope="col">{t.audit.action}</th>
              <th scope="col">{t.audit.module}</th>
              <th scope="col">{t.audit.record}</th>
              <th scope="col">{t.audit.by}</th>
              <th scope="col">{t.audit.changes}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && <tr><td colSpan={6} className="adm-table__empty">{t.audit.empty}</td></tr>}
            {items.map((a) => (
              <tr key={a.id}>
                <td className="adm-small adm-nowrap">{formatDate(a.createdAt)}</td>
                <td><strong>{a.action}</strong></td>
                <td className="adm-small">{a.module}</td>
                <td className="adm-small"><code>{a.recordId ?? "—"}</code></td>
                <td className="adm-small">{a.userEmail ?? "—"}</td>
                <td className="adm-small">
                  {a.oldValue !== null && <div><code className="adm-json">− {JSON.stringify(a.oldValue)}</code></div>}
                  {a.newValue !== null && <div><code className="adm-json">+ {JSON.stringify(a.newValue)}</code></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && <Button variant="secondary" busy={loading} onClick={more}>{t.common.loadMore}</Button>}
    </section>
  );
}
