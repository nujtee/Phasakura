import type { BookingStatus } from "../../../shared/booking-types.ts";
import { useAdmin } from "../AdminContext.tsx";

const TONE: Record<BookingStatus, string> = {
  PENDING: "warning",
  CONFIRMED: "active",
  CHECKED_IN: "active",
  CHECKED_OUT: "muted",
  CANCELLED: "deleted",
  EXPIRED: "muted",
  NO_SHOW: "deleted",
};

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const { t } = useAdmin();
  return <span className={`adm-badge adm-badge--${TONE[status]}`}>{t.bk[`s${status}`]}</span>;
}

/** Business date (YYYY-MM-DD) in the admin language, never shifted by the browser's time zone. */
export function useStayDate() {
  const { locale } = useAdmin();
  const fmt = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return (date: string) => fmt.format(new Date(`${date}T00:00:00Z`));
}
