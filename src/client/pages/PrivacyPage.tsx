import type { PublicPrivacyDto } from "../../shared/settings-types.ts";
import { getConsentMessages } from "../../shared/i18n/consent-messages.ts";
import { useConsent } from "../consent/ConsentProvider.tsx";
import { usePublicData } from "../content/usePublicData.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { EmptyState } from "../components/EmptyState.tsx";

const INTL_TAG: Record<string, string> = { th: "th-TH-u-ca-buddhist", en: "en-GB", "zh-CN": "zh-CN" };

/** A line that is short and has no full stop reads as a sub-heading ("1. ข้อมูลที่เราเก็บ"). */
const isHeading = (block: string) => !block.includes("\n") && block.length <= 80 && !/[.。:：]$/.test(block) && /^(\d+[.)]|[#]+)\s*\S/.test(block);

/**
 * Privacy policy (Settings → Privacy, plain text per language; Thai when a language has none).
 * Blank lines separate paragraphs; "1. Title" lines become sub-headings; "- item" lines become lists.
 */
export function PrivacyPage({ title }: { title: string }) {
  const { locale, t } = useI18n();
  const cm = getConsentMessages(locale.code);
  const { manageable, openSettings } = useConsent();
  const { data, error, retry } = usePublicData<PublicPrivacyDto>(`/api/public/privacy?lang=${locale.path}`);

  if (error) {
    return (
      <section className="page container" aria-labelledby="page-title">
        <h1 id="page-title" className="page__title">{title}</h1>
        <div className="empty-state" role="alert"><p>{t.common.loadError}</p><button type="button" className="button button--primary" onClick={retry}>{t.common.retry}</button></div>
      </section>
    );
  }
  if (!data) return <section className="page container" aria-busy="true"><h1 className="page__title">{title}</h1><div className="skeleton skeleton--text" /></section>;

  const blocks = (data.body ?? "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const updated = data.updatedAt ? new Intl.DateTimeFormat(INTL_TAG[locale.code] ?? locale.code, { dateStyle: "long" }).format(new Date(data.updatedAt)) : null;

  return (
    <article className="page container privacy-page" aria-labelledby="page-title">
      <h1 id="page-title" className="page__title">{data.title ?? title}</h1>
      {updated && <p className="privacy-page__updated">{cm.privacy.updated.replace("{date}", updated)}</p>}
      {!blocks.length && <EmptyState message={cm.privacy.empty} />}
      <div className="privacy-page__body">
        {blocks.map((b, i) => {
          if (isHeading(b)) return <h2 key={i}>{b.replace(/^#+\s*/, "")}</h2>;
          const lines = b.split("\n");
          if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) {
            return <ul key={i}>{lines.map((l, j) => <li key={j}>{l.replace(/^\s*[-•*]\s+/, "")}</li>)}</ul>;
          }
          return <p key={i}>{lines.map((l, j) => (j ? [<br key={`b${j}`} />, l] : l))}</p>;
        })}
      </div>
      {manageable && (
        <p className="privacy-page__manage">
          <button type="button" className="button button--secondary" onClick={openSettings} aria-haspopup="dialog">{cm.privacy.manage}</button>
        </p>
      )}
    </article>
  );
}
