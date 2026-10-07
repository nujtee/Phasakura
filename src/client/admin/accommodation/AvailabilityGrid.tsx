import { useCallback, useEffect, useState } from "react";
import type { AdminAvailabilityDto, UnitType } from "../../../shared/accommodation-types.ts";
import { addDays, todayIn, DEFAULT_TIMEZONE } from "../../../shared/dates.ts";
import { apiGet } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage } from "../ui.tsx";

const DAYS = 14;

/** Units × nights grid (booked / blocked / free). Optionally filtered to one unit type or one unit. */
export function AvailabilityGrid({ type, unitId, reloadKey = 0 }: { type?: UnitType; unitId?: string; reloadKey?: number }) {
  const { t, locale } = useAdmin();
  const [from, setFrom] = useState(() => todayIn(DEFAULT_TIMEZONE));
  const [data, setData] = useState<AdminAvailabilityDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await apiGet<AdminAvailabilityDto>(`/api/admin/availability?from=${from}&days=${DAYS}`, signal));
      setError(null);
    } catch (err) {
      if (!signal?.aborted) setError(errorMessage(t, err));
    }
  }, [from, t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadKey]);

  const weekday = new Intl.DateTimeFormat(locale.code, { weekday: "short", timeZone: "UTC" });
  const dayMonth = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", timeZone: "UTC" });
  const units = (data?.units ?? []).filter((u) => (!type || u.unitType === type) && (!unitId || u.id === unitId));

  return (
    <section className="adm-card">
      <div className="adm-pagehead">
        <h2 className="adm-h2">{t.acc.availability}</h2>
        <div className="adm-row" style={{ marginTop: 0 }}>
          <Button variant="secondary" onClick={() => setFrom((f) => addDays(f, -DAYS))} aria-label={t.acc.prev}>←</Button>
          <Button variant="secondary" onClick={() => setFrom((f) => addDays(f, DAYS))} aria-label={t.acc.next}>→</Button>
        </div>
      </div>
      <ul className="adm-legend" aria-hidden="true">
        <li><span className="adm-cell adm-cell--FREE" /> {t.acc.free}</li>
        <li><span className="adm-cell adm-cell--BOOKED" /> {t.acc.booked}</li>
        <li><span className="adm-cell adm-cell--BLOCKED" /> {t.acc.blocked}</li>
      </ul>
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <div className="adm-tablewrap">
          <table className="adm-grid">
            <thead>
              <tr>
                <th scope="col" className="adm-grid__unit">{t.acc.code}</th>
                {data.dates.map((d) => {
                  const date = new Date(`${d}T00:00:00Z`);
                  return <th key={d} scope="col"><span>{weekday.format(date)}</span><br />{dayMonth.format(date)}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.id}>
                  <th scope="row" className="adm-grid__unit">
                    <strong>{u.unitCode}</strong>
                    <span className="adm-small adm-muted"> {u.name}</span>
                  </th>
                  {data.dates.map((d) => {
                    const n = u.nights[d]!;
                    const label = n.state === "BOOKED" ? `${t.acc.booked}${n.bookingCode ? ` ${n.bookingCode}` : ""}`
                      : n.state === "BLOCKED" ? `${t.acc.blocked}${n.blockReason ? `: ${n.blockReason}` : ""}` : t.acc.free;
                    return (
                      <td key={d} className={`adm-cell adm-cell--${n.state}`} title={label}>
                        <span className="visually-hidden">{`${d}: ${label}`}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {units.length === 0 && <tr><td colSpan={data.dates.length + 1} className="adm-table__empty">{t.acc.empty}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
