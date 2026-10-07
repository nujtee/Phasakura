import { getContentMessages, type ContentMessages } from "../../shared/i18n/content-messages.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function useContentT(): ContentMessages {
  const { locale } = useI18n();
  return getContentMessages(locale.code);
}
