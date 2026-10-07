import { useEffect, useState } from "react";
import type { AdminUnitDto, UnitType } from "../../../shared/accommodation-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage } from "../ui.tsx";
import { AvailabilityGrid } from "./AvailabilityGrid.tsx";

export const TYPE_PATH: Record<UnitType, string> = { HOUSE: "houses", VIP_TENT: "vip-tents" };

export function unitName(u: AdminUnitDto, lang: string, fallback: string): string {
  return u.translations[lang as "th"]?.name ?? u.translations.th?.name ?? fallback;
}

export function UnitStatusBadge({ status }: { status: AdminUnitDto["status"] }) {
  const { t } = useAdmin();
  const cls = status === "ACTIVE" ? "active" : status === "DRAFT" ? "deleted" : "suspended";
  return <span className={`adm-badge adm-badge--${cls}`}>{(t.acc as Record<string, string>)[`status${status}`] ?? status}</span>;
}

/** Houses / VIP tents list (spec §12: each unit is separate inventory). */
export function UnitsPage({ type }: { type: UnitType }) {
  const { t, can, href, go, locale } = useAdmin();
  const [units, setUnits] = useState<AdminUnitDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setUnits(null);
    apiGet<AdminUnitDto[]>(`/api/admin/accommodations?type=${type}`, controller.signal)
      .then(setUnits)
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [type, t]);

  const title = type === "HOUSE" ? t.acc.housesTitle : t.acc.vipTitle;
  const path = TYPE_PATH[type];

  return (
    <section>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{title}</h1>
        {can("accommodation.edit") && can("pricing.edit") && (
          <Button onClick={() => go(path, "new")}>+ {type === "HOUSE" ? t.acc.newHouse : t.acc.newVip}</Button>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!units && !error && <p role="status">{t.common.loading}</p>}
      {units && units.length === 0 && <div className="adm-empty">{t.acc.empty}</div>}
      {units && units.length > 0 && (
        <ul className="adm-unitlist">
          {units.map((u) => (
            <li key={u.id} className="adm-unit">
              <div className="adm-unit__thumb">
                {u.coverUrl ? <img src={u.coverUrl} alt="" loading="lazy" /> : <span aria-hidden="true" />}
              </div>
              <div className="adm-unit__body">
                <Link to={href(path, u.id)} className="adm-table__primary">
                  {u.unitCode} — {unitName(u, locale.code, t.acc.noName)}
                </Link>
                <div className="adm-small adm-muted">
                  {formatBaht(u.basePriceSatang, locale.code)} · {format(t.acc.guests, { n: `${u.standardGuests}–${u.maxGuests}` })} · {u.images.length} {t.acc.images}
                </div>
              </div>
              <UnitStatusBadge status={u.status} />
            </li>
          ))}
        </ul>
      )}
      <AvailabilityGrid type={type} />
    </section>
  );
}
