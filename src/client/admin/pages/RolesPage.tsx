import { useEffect, useMemo, useState } from "react";
import type { PermissionDto, RoleDto } from "../../../shared/auth-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage } from "../ui.tsx";

export function RolesPage() {
  const { t, locale, can, me } = useAdmin();
  const [roles, setRoles] = useState<RoleDto[] | null>(null);
  const [catalog, setCatalog] = useState<PermissionDto[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const isSuperAdmin = !!me?.roles.includes("SUPER_ADMIN");
  const canEdit = isSuperAdmin && can("users.manage_permissions");

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      apiGet<RoleDto[]>(`/api/admin/roles?lang=${locale.path}`, controller.signal).then(setRoles),
      apiGet<PermissionDto[]>("/api/admin/permissions", controller.signal).then(setCatalog),
    ]).catch((err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: errorMessage(t, err) }));
    return () => controller.abort();
  }, [locale, t]);

  const modules = useMemo(() => {
    const m = new Map<string, PermissionDto[]>();
    for (const p of catalog) m.set(p.module, [...(m.get(p.module) ?? []), p]);
    return [...m.entries()];
  }, [catalog]);

  async function save(role: RoleDto) {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await apiRequest<RoleDto>(
        "PUT",
        `/api/admin/roles/${encodeURIComponent(role.id)}/permissions?lang=${locale.path}`,
        { permissions: [...draft] },
      );
      setRoles((prev) => prev?.map((r) => (r.id === updated.id ? updated : r)) ?? null);
      setEditing(null);
      setMessage({ kind: "success", text: t.common.saved });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className="adm-h1">{t.roles.title}</h1>
      {!canEdit && <p className="adm-muted adm-small">{t.roles.onlySuperAdmin}</p>}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {!roles && !message && <p role="status">{t.common.loading}</p>}
      {roles?.map((role) => {
        const locked = role.code === "SUPER_ADMIN";
        const isEditing = editing === role.id;
        return (
          <article key={role.id} className="adm-card">
            <div className="adm-pagehead">
              <div>
                <h2 className="adm-h2">{role.name} <code className="adm-small">{role.code}</code></h2>
                {role.description && <p className="adm-muted adm-small">{role.description}</p>}
                <p className="adm-small">
                  {format(t.roles.users, { n: role.userCount })} · {format(t.roles.permissionCount, { n: role.permissions.length })}
                </p>
              </div>
              {canEdit && !locked && !isEditing && (
                <Button variant="secondary" onClick={() => { setEditing(role.id); setDraft(new Set(role.permissions)); }}>
                  {t.roles.editPermissions}
                </Button>
              )}
            </div>
            {locked && <p className="adm-muted adm-small">{t.roles.lockedRole}</p>}
            {isEditing ? (
              <>
                {modules.map(([module, perms]) => (
                  <fieldset key={module} className="adm-permgroup">
                    <legend>{module}</legend>
                    {perms.map((p) => (
                      <label key={p.code} className="adm-check">
                        <input type="checkbox" checked={draft.has(p.code)}
                          onChange={(e) => setDraft((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(p.code);
                            else next.delete(p.code);
                            return next;
                          })} />
                        <code>{p.code}</code> <span className="adm-muted adm-small">{p.description}</span>
                      </label>
                    ))}
                  </fieldset>
                ))}
                <div className="adm-row">
                  <Button onClick={() => void save(role)} busy={busy}>{t.common.save}</Button>
                  <Button variant="secondary" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
                </div>
              </>
            ) : (
              !locked && (
                <details>
                  <summary>{format(t.roles.permissionCount, { n: role.permissions.length })}</summary>
                  <ul className="adm-chips">{role.permissions.map((p) => <li key={p} className="adm-chip adm-chip--code">{p}</li>)}</ul>
                </details>
              )
            )}
          </article>
        );
      })}
    </section>
  );
}
