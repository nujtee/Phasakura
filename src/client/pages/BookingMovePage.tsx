import { useId } from "react";
import { MoveStayLauncher } from "../booking/MoveStay.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** Menu → "เลื่อนวันเข้าพัก": Booking ID + phone, then new dates (was a box on the booking page). */
export function BookingMovePage() {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="page container move-page">
      <h1 className="page__title" id={`${id}-h`}>{t.pages.bookingMove.title}</h1>
      <p className="page__lead">{t.pages.bookingMove.lead}</p>
      <MoveStayLauncher labelledBy={`${id}-h`} />
    </div>
  );
}
