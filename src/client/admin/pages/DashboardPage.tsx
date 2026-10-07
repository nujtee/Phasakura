import { format } from "../../../shared/i18n/admin-messages.ts";
import { useAdmin } from "../AdminContext.tsx";

/** Phase 3: greeting + roles. Booking/revenue widgets arrive in Phase 9. */
export function DashboardPage() {
  const { t, me } = useAdmin();
  return (
    <section>
      <h1 className="adm-h1">{format(t.dashboard.welcome, { name: me?.displayName ?? "" })}</h1>
      <p className="adm-muted">{t.dashboard.intro}</p>
      <div className="adm-card">
        <h2 className="adm-h2">{t.dashboard.yourRoles}</h2>
        <ul className="adm-chips">
          {me?.roles.map((r) => <li key={r} className="adm-chip">{r}</li>)}
        </ul>
      </div>
    </section>
  );
}
