import { useEffect, useState } from "react";
import type { PermissionDto, RoleDto } from "../../../shared/auth-types.ts";
import { apiGet } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, errorMessage } from "../ui.tsx";

export function PermissionsPage() {
  const { t, locale } = useAdmin();
  const [catalog, setCatalog] = useState<PermissionDto[] | null>(null);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      apiGet<PermissionDto[]>("/api/admin/permissions", controller.signal).then(setCatalog),
      apiGet<RoleDto[]>(`/api/admin/roles?lang=${locale.path}`, controller.signal).then(setRoles),
    ]).catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [locale, t]);

  return (
    <section>
      <h1 className="adm-h1">{t.permissions.title}</h1>
      {error && <Alert kind="error">{error}</Alert>}
      {!catalog && !error && <p role="status">{t.common.loading}</p>}
      {catalog && (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{t.permissions.code}</th>
                <th scope="col">{t.permissions.description}</th>
                <th scope="col">{t.permissions.heldBy}</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((p) => (
                <tr key={p.code}>
                  <td><code>{p.code}</code></td>
                  <td className="adm-small">{p.description}</td>
                  <td>
                    <ul className="adm-chips">
                      {roles.filter((r) => r.permissions.includes(p.code)).map((r) => <li key={r.code} className="adm-chip">{r.code}</li>)}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
