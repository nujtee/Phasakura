import { useState, type ReactNode } from "react";
import type { PaymentInstructionsDto } from "../../shared/payment-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { useDateTimeText } from "./Summary.tsx";
import { useBookingT } from "./useBookingT.ts";

function CopyRow({ label, value }: { label: string; value: string }) {
  const bt = useBookingT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="pay__row">
      <dt>{label}</dt>
      <dd>
        <span className="pay__value" translate="no">{value}</span>
        <button type="button" className="pay__copy" aria-label={`${bt.copyNumber}: ${label}`}
          onClick={() => navigator.clipboard.writeText(value.replace(/[^\d]/g, "")).then(() => setCopied(true), () => setCopied(false))}>
          {copied ? bt.copied : bt.copy}
        </button>
      </dd>
    </div>
  );
}

/** Where to transfer — always from the booking's own account snapshot, never the current settings. */
export function PaymentInstructions({ payment, expiresAt, children }: { payment: PaymentInstructionsDto; expiresAt: string | null; children?: ReactNode }) {
  const { locale } = useI18n();
  const bt = useBookingT();
  const timeText = useDateTimeText();
  return (
    <section className="pay" aria-labelledby="pay-h">
      <h2 id="pay-h" className="pay__title">{bt.payTitle}</h2>
      <p className="pay__amount">
        <span>{bt.amountDue}</span>
        <strong>{formatBaht(payment.amountDueSatang, locale.code)}</strong>
      </p>
      {expiresAt && <p className="pay__deadline">{fill(bt.holdUntil, { time: timeText(expiresAt) })}</p>}
      <div className="pay__body">
        {payment.qrUrl && <img className="pay__qr" src={payment.qrUrl} alt={bt.qrAlt} width={220} height={220} decoding="async" />}
        <dl className="pay__details">
          <div className="pay__row"><dt>{bt.bankName}</dt><dd>{payment.bankName}</dd></div>
          <div className="pay__row"><dt>{bt.accountName}</dt><dd>{payment.accountName}</dd></div>
          {payment.accountNumber && <CopyRow label={bt.accountNumber} value={payment.accountNumber} />}
          {payment.promptpayNumber && <CopyRow label={bt.promptpay} value={payment.promptpayNumber} />}
        </dl>
      </div>
      <p className="pay__note">{bt.payNote}</p>
      {children}
    </section>
  );
}
