import type { SitePage } from "../../shared/routes.ts";
import { LineIcon } from "../booking/LineUpdates.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useSite } from "../site/SiteProvider.tsx";

/**
 * Floating "chat with us on LINE" button (Settings → LINE → show on website). Opens the
 * Official Account (add friend / chat). Stacks above the floating booking button and is not
 * shown on the booking pages, so it never covers the booking form.
 */
export function LineButton({ page }: { page: SitePage | null }) {
  const { site } = useSite();
  const { t } = useI18n();
  const url = site?.lineButton?.url;
  const pageKey = page === "bookingLookup" ? "booking" : page;
  if (!url || !/^https:\/\//.test(url) || page === null || pageKey === "booking") return null;
  return (
    <a className="line-fab" href={url} target="_blank" rel="noopener noreferrer" aria-label={t.common.lineChat} title={t.common.lineChat}>
      <LineIcon size={22} />
      <span className="line-fab__text" aria-hidden="true">LINE</span>
    </a>
  );
}
