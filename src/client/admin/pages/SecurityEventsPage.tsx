import { useCallback, useState } from "react";
import type { SecurityEventDto } from "../../../shared/auth-types.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, useDateFormatter } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";

const EVENT_TYPES = [
  "LOGIN_SUCCESS", "LOGIN_FAILED", "LOGIN_THROTTLED", "ACCOUNT_LOCKED", "LOGIN_BLOCKED_SUSPENDED", "LOGOUT",
  "PERMISSION_DENIED", "PRIVILEGE_ESCALATION_BLOCKED", "PASSWORD_CHANGED", "PASSWORD_CHANGE_FAILED",
  "PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_COMPLETED", "PASSWORD_RESET_INVALID_TOKEN", "PASSWORD_RESET_THROTTLED",
  "PASSWORD_RESET_NOT_DELIVERED", "ADMIN_PASSWORD_RESET_ISSUED", "FORCE_LOGOUT",
];

export function SecurityEventsPage() {
  const { t } = useAdmin();
  const formatDate = useDateFormatter();
  const [type, setType] = useState("");
  const buildUrl = useCallback((before: string | null) => {
    const p = new URLSearchParams({ limit: "50" });
    if (type) p.set("type", type);
    if (before) p.set("before", before);
    return `/api/admin/security-events?${p}`;
  }, [type]);
  const { items, cursor, loading, error, more } = useCursorList<SecurityEventDto>(buildUrl);

  return (
    <section>
      <h1 className="adm-h1">{t.events.title}</h1>
      <div className="adm-toolbar">
        <div className="adm-field adm-field--inline">
          <label htmlFor="ev-type">{t.events.type}</label>
          <select id="ev-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t.events.allTypes}</option>
            {EVENT_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{t.events.time}</th>
              <th scope="col">{t.events.type}</th>
              <th scope="col">{t.events.user}</th>
              <th scope="col">{t.events.ip}</th>
              <th scope="col">{t.events.details}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && <tr><td colSpan={5} className="adm-table__empty">{t.events.empty}</td></tr>}
            {items.map((e) => (
              <tr key={e.id}>
                <td className="adm-small adm-nowrap">{formatDate(e.createdAt)}</td>
                <td><span className={`adm-sev adm-sev--${e.severity.toLowerCase()}`}>{e.eventType}</span></td>
                <td className="adm-small">{e.userEmail ?? e.identifier ?? "—"}</td>
                <td className="adm-small adm-nowrap">{e.ip ?? "—"}</td>
                <td className="adm-small"><code className="adm-json">{e.details ? JSON.stringify(e.details) : ""}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && <Button variant="secondary" busy={loading} onClick={more}>{t.common.loadMore}</Button>}
    </section>
  );
}
