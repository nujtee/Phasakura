import { getBookingMessages, type BookingMessages } from "../../shared/i18n/booking-messages.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** Booking-flow strings for the current language. */
export function useBookingT(): BookingMessages {
  return getBookingMessages(useI18n().locale.code);
}
