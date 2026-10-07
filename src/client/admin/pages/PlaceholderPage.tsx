import { useAdmin } from "../AdminContext.tsx";
import { findNavItem } from "../nav.ts";

/** Sidebar sections that ship in later phases, and admin 404. Access is still permission-checked. */
export function PlaceholderPage({ title, navPath }: { title: string | null; navPath?: string }) {
  const { t, can } = useAdmin();
  const item = navPath ? findNavItem(navPath) : undefined;
  if (item && !can(item.permission)) {
    return (
      <section>
        <h1 className="adm-h1">{item.label(t)}</h1>
        <div className="adm-empty" role="alert">{t.errors.FORBIDDEN}</div>
      </section>
    );
  }
  return (
    <section>
      <h1 className="adm-h1">{item ? item.label(t) : (title ?? t.common.notFound)}</h1>
      <div className="adm-empty" role="status">{item ? t.common.comingSoon : t.common.notFound}</div>
    </section>
  );
}
