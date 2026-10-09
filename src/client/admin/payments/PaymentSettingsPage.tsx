import { useEffect, useState, type FormEvent } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getNotifyMessages } from "../../../shared/i18n/admin-notify-messages.ts";
import { PAYMENT_CHANNELS, type ApprovalMode, type PaymentChannel, type PaymentSettingsDto } from "../../../shared/payment-types.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage } from "../ui.tsx";

/** Finance → Payment settings: ways to pay offered to guests, and Auto / Manual slip approval. */
export function PaymentSettingsPage() {
  const { t, can, href, locale } = useAdmin();
  const n = getNotifyMessages(locale.code).payment;
  const errs = getNotifyMessages(locale.code).errors as Record<string, string>;
  const canEdit = can("receiving_accounts.edit");
  const [s, setS] = useState<PaymentSettingsDto | null>(null);
  const [mode, setMode] = useState<ApprovalMode>("AUTO");
  const [channels, setChannels] = useState<Record<PaymentChannel, boolean> | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (d: PaymentSettingsDto) => {
    setS(d);
    setMode(d.approvalMode);
    setChannels(d.channels);
  };
  useEffect(() => {
    apiGet<PaymentSettingsDto>("/api/admin/payment-settings").then(apply, (err: unknown) => setMsg({ kind: "error", text: errorMessage(t, err) }));
  }, [t]);

  const text = (err: unknown) => {
    if (err instanceof ApiError) {
      for (const code of Object.values(err.details)) if (errs[code]) return errs[code]!;
      if (errs[err.code]) return errs[err.code]!;
    }
    return errorMessage(t, err);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!channels) return;
    setBusy(true);
    setMsg(null);
    try {
      apply(await apiRequest<PaymentSettingsDto>("PUT", "/api/admin/payment-settings", { approvalMode: mode, channels }));
      setMsg({ kind: "success", text: n.saved });
    } catch (err) {
      setMsg({ kind: "error", text: text(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!s || !channels) return msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <p role="status">{t.common.loading}</p>;
  const possible: Record<PaymentChannel, boolean> = {
    PROMPTPAY: !!s.account?.promptpay, BANK_TRANSFER: !!s.account?.bankAccount, QR_CODE: !!s.account?.qr, PAYPAL: s.paypal.configured,
  };

  return (
    <section className="pay-settings">
      <h1 className="adm-h1">{n.title}</h1>
      <p className="adm-muted">{n.intro}</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!s.account && (
        <Alert kind="error">{n.noAccount} <Link to={href("receiving-accounts")}>{n.accountsLink}</Link></Alert>
      )}
      <form onSubmit={(e) => void save(e)} noValidate>
        <fieldset className="adm-fieldset" disabled={!canEdit || busy}>
          <div className="adm-card">
            <h2 className="adm-h2">{n.channelsTitle}</h2>
            <p className="adm-field__hint">{n.channelsHint}</p>
            <div className="pay-settings__channels">
              {PAYMENT_CHANNELS.map((c) => (
                <label key={c} className={`adm-check pay-settings__channel${possible[c] ? "" : " is-unavailable"}`}>
                  <input type="checkbox" checked={channels[c]} disabled={c === "PAYPAL" && !s.paypal.configured && !channels.PAYPAL}
                    onChange={(e) => setChannels({ ...channels, [c]: e.currentTarget.checked })} />
                  <span>
                    {n.channels[c]}
                    {!possible[c] && <small className="adm-field__hint pay-settings__missing">{n.missing[c]}</small>}
                    {c === "PAYPAL" && s.paypal.configured && (
                      <small className="adm-field__hint">{format(n.paypalMode, { env: s.paypal.environment === "live" ? n.paypalLive : n.paypalSandbox })}</small>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <p className="adm-small"><Link to={href("receiving-accounts")}>{n.accountsLink}</Link></p>
          </div>

          <div className="adm-card">
            <h2 className="adm-h2">{n.approvalTitle}</h2>
            <div className="pay-settings__modes" role="radiogroup" aria-label={n.approvalTitle}>
              {(["AUTO", "MANUAL"] as const).map((m) => (
                <label key={m} className={`pay-settings__mode${mode === m ? " is-selected" : ""}`}>
                  <input type="radio" name="approval-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                  <span>
                    <strong>{m === "AUTO" ? n.auto : n.manual}</strong>
                    <small>{m === "AUTO" ? n.autoHint : n.manualHint}</small>
                  </span>
                </label>
              ))}
            </div>
            <dl className="adm-dl">
              <dt>{n.verifier}</dt>
              <dd>
                {s.slipVerifier.configured
                  ? <span className="adm-badge adm-badge--active">✓ {format(n.verifierOn, { provider: s.slipVerifier.provider ?? "" })}</span>
                  : <span className="adm-badge adm-badge--suspended">{n.verifierOff}</span>}
              </dd>
            </dl>
            {mode === "AUTO" && !s.slipVerifier.configured && <Alert kind="info">{n.autoWithoutVerifier}</Alert>}
            <p className="adm-field__hint">{n.notifyNote}</p>
            <p className="adm-small"><Link to={href("slips")}>{n.reviewLink}</Link></p>
          </div>

          {canEdit && <Button type="submit" busy={busy}>{t.common.save}</Button>}
        </fieldset>
      </form>
    </section>
  );
}
