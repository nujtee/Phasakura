import { useId } from "react";
import { getConsentMessages } from "../../shared/i18n/consent-messages.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";

/**
 * Cookie banner (spec §46). Not modal: the page stays usable, nothing optional runs until a choice
 * is made. The three choices look the same, so refusing is as easy as accepting.
 */
export function ConsentBanner({ text, policyPath, onAcceptAll, onReject, onSettings }: {
  text: string | null;
  policyPath: string | null;
  onAcceptAll: () => void;
  onReject: () => void;
  onSettings: () => void;
}) {
  const { locale } = useI18n();
  const cm = getConsentMessages(locale.code);
  const id = useId();
  return (
    <section className="consent-banner" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}>
      <div className="consent-banner__inner">
        <div className="consent-banner__text">
          <p id={`${id}-t`} className="consent-banner__title">{cm.title}</p>
          <p id={`${id}-d`} className="consent-banner__body">
            {text || cm.text}
            {policyPath && <> <Link to={policyPath} className="consent-banner__link">{cm.policy}</Link></>}
          </p>
        </div>
        <div className="consent-banner__actions">
          <button type="button" className="consent-button" onClick={onAcceptAll}>{cm.acceptAll}</button>
          <button type="button" className="consent-button" onClick={onSettings} aria-haspopup="dialog">{cm.settings}</button>
          <button type="button" className="consent-button" onClick={onReject}>{cm.rejectOptional}</button>
        </div>
      </div>
    </section>
  );
}
