import { useEffect, useId, useRef, useState } from "react";
import type { ConsentState } from "../../shared/consent.ts";
import { getConsentMessages } from "../../shared/i18n/consent-messages.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";

/**
 * Cookie settings (spec §46): Necessary (always on), Analytics, Marketing. Modal <dialog>:
 * focus is trapped by the browser, Esc closes without saving, focus returns to the opener.
 * Optional categories start switched off until the visitor turns them on.
 */
export function ConsentDialog({ initial, onSave, onClose, policyPath }: {
  initial: ConsentState | null;
  onSave: (analytics: boolean, marketing: boolean) => void;
  onClose: () => void;
  policyPath: string | null;
}) {
  const { locale } = useI18n();
  const cm = getConsentMessages(locale.code);
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [analytics, setAnalytics] = useState(initial?.analytics ?? false);
  const [marketing, setMarketing] = useState(initial?.marketing ?? false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open && typeof d.showModal === "function") d.showModal();
  }, []);

  const row = (key: "necessary" | "analytics" | "marketing", value: boolean, set?: (v: boolean) => void) => (
    <li className="consent-option">
      <div className="consent-option__text">
        <label htmlFor={`${id}-${key}`} className="consent-option__name">{cm.categories[key].name}</label>
        <p id={`${id}-${key}-d`} className="consent-option__desc">{cm.categories[key].text}</p>
      </div>
      <div className="consent-option__control">
        <input id={`${id}-${key}`} type="checkbox" role="switch" className="consent-switch" checked={value}
          disabled={!set} aria-describedby={`${id}-${key}-d`} onChange={(e) => set?.(e.target.checked)} />
        {!set && <span className="consent-option__always">{cm.alwaysOn}</span>}
      </div>
    </li>
  );

  return (
    <dialog ref={ref} className="consent-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
      <div className="consent-dialog__panel">
        <div className="consent-dialog__head">
          <h2 id={`${id}-title`} className="consent-dialog__title">{cm.dialogTitle}</h2>
          <button type="button" className="consent-dialog__close" onClick={onClose} aria-label={cm.close}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p id={`${id}-intro`} className="consent-dialog__intro">
          {cm.dialogIntro}
          {policyPath && <> <Link to={policyPath} onClick={onClose}>{cm.policy}</Link></>}
        </p>
        <ul className="consent-options">
          {row("necessary", true)}
          {row("analytics", analytics, setAnalytics)}
          {row("marketing", marketing, setMarketing)}
        </ul>
        <div className="consent-dialog__actions">
          <button type="button" className="consent-button" onClick={() => onSave(analytics, marketing)}>{cm.save}</button>
          <button type="button" className="consent-button" onClick={() => onSave(false, false)}>{cm.rejectOptional}</button>
          <button type="button" className="consent-button" onClick={() => onSave(true, true)}>{cm.acceptAll}</button>
        </div>
      </div>
    </dialog>
  );
}
