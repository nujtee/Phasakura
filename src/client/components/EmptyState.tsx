import { useI18n } from "../i18n/I18nProvider.tsx";

/** Neutral empty state used until CMS content is published. */
export function EmptyState({ message }: { message?: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-state" role="status">
      <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
        <rect x="6" y="10" width="36" height="28" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M6 32l10-10 8 8 6-6 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="33" cy="19" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <p>{message ?? t.common.contentPending}</p>
    </div>
  );
}
