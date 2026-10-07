import { useEffect, useState, type FormEvent } from "react";
import type { AdminUserListDto } from "../../../shared/auth-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, StatusBadge, useDateFormatter } from "../ui.tsx";

type Tab = "" | "SUSPENDED" | "DELETED";

export function UsersPage() {
  const { t, can, href, go, me } = useAdmin();
  const formatDate = useDateFormatter();
  const [tab, setTab] = useState<Tab>("");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminUserListDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (tab) params.set("status", tab);
    if (submittedQuery) params.set("q", submittedQuery);
    setError(null);
    apiGet<AdminUserListDto>(`/api/admin/users?${params}`, controller.signal)
      .then(setData)
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [tab, submittedQuery, page, t]);

  const tabs: { value: Tab; label: string }[] = [
    { value: "", label: `${t.users.statusActive} / ${t.users.statusSuspended}` },
    { value: "SUSPENDED", label: t.users.statusSuspended },
    { value: "DELETED", label: t.users.statusDeleted },
  ];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{t.users.title}</h1>
        {can("users.create") && <Button onClick={() => go("users", "new")}>+ {t.users.newUser}</Button>}
      </div>

      <div className="adm-toolbar">
        <div role="tablist" aria-label={t.users.status} className="adm-tabs">
          {tabs.map((x) => (
            <button key={x.value} role="tab" type="button" aria-selected={tab === x.value}
              className="adm-tab" onClick={() => { setTab(x.value); setPage(1); }}>
              {x.label}
            </button>
          ))}
        </div>
        <form role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setSubmittedQuery(query.trim()); setPage(1); }} className="adm-search">
          <input type="search" aria-label={t.common.search} placeholder={t.users.searchPlaceholder} value={query}
            onChange={(e) => setQuery(e.target.value)} maxLength={100} />
          <Button type="submit" variant="secondary">{t.common.search}</Button>
        </form>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <p role="status">{t.common.loading}</p>}
      {data && (
        <>
          <p className="adm-muted" aria-live="polite">{format(t.users.total, { n: data.total })}</p>
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">{t.users.name}</th>
                  <th scope="col">{t.users.roles}</th>
                  <th scope="col">{t.users.status}</th>
                  <th scope="col">{t.users.lastLogin}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 && (
                  <tr><td colSpan={4} className="adm-table__empty">{t.users.empty}</td></tr>
                )}
                {data.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link to={href("users", u.id)} className="adm-table__primary">{u.displayName}</Link>
                      {u.id === me?.id && <span className="adm-chip adm-chip--muted"> {t.users.you}</span>}
                      <div className="adm-muted adm-small">{u.email}</div>
                    </td>
                    <td>
                      <ul className="adm-chips">{u.roles.map((r) => <li key={r} className="adm-chip">{r}</li>)}</ul>
                    </td>
                    <td>
                      <StatusBadge status={u.status} />
                      {u.mustChangePassword && <div className="adm-small adm-muted">{t.users.mustChange}</div>}
                    </td>
                    <td className="adm-small">{u.lastLoginAt ? formatDate(u.lastLoginAt) : t.users.never}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav className="adm-pager" aria-label="pagination">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t.users.prev}</Button>
              <span>{page} / {pages}</span>
              <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{t.users.next}</Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
