import { useCallback, useState, type FormEvent } from "react";
import type { SlipQueueItemDto, SlipVerificationDto } from "../../../shared/payment-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { useStayDate } from "../bookings/shared.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, useDateFormatter } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";

type Tab = "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED";

export function useFailureText() {
  const { t } = useAdmin();
  return (code: string | null) => {
    if (!code) return "";
    const known = (t.slip as Record<string, string>)[`f${code}`];
    return known ?? format(t.slip.fOther, { code });
  };
}

function Check({ v }: { v: SlipVerificationDto }) {
  const { t, locale } = useAdmin();
  const dateTime = useDateFormatter();
  const failure = useFailureText();
  return (
    <li className={`adm-check adm-check--${v.result.toLowerCase()}`}>
      <strong>{v.method === "AUTO" ? `${t.slip.auto}${v.provider ? ` (${v.provider})` : ""}` : `${t.slip.manual}${v.verifiedByName ? ` · ${v.verifiedByName}` : ""}`}</strong>
      {" · "}{t.slip[`r${v.result}`]}
      {v.failureCode && <> — {failure(v.failureCode)}</>}
      <div className="adm-small adm-muted">
        {v.amountSatang !== null && <>{t.slip.amountOnSlip}: {formatBaht(v.amountSatang, locale.code)} · </>}
        {v.transferredAt && <>{t.slip.transferredAt}: {dateTime(v.transferredAt)} · </>}
        {v.senderBank && <>{t.slip.sender}: {v.senderBank} · </>}
        {v.receiverAccountMasked && <>{t.slip.receiver}: <span className="adm-mono">{v.receiverAccountMasked}</span>{v.receiverBank && ` (${v.receiverBank})`} · </>}
        {v.transactionRef && <>{t.slip.txRef}: <span className="adm-mono">{v.transactionRef}</span> · </>}
        {dateTime(v.createdAt)}
      </div>
    </li>
  );
}

function SlipCard({ item, onChanged }: { item: SlipQueueItemDto; onChanged: (text: string) => void }) {
  const { t, can, href, locale } = useAdmin();
  const dateTime = useDateFormatter();
  const stayDate = useStayDate();
  const [ref, setRef] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<"verify" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canAct = item.status === "PENDING_VERIFICATION" && can("payments.verify");

  async function act(kind: "verify" | "reject") {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", `/api/admin/payments/${encodeURIComponent(item.paymentId)}/${kind}`,
        kind === "verify" ? (ref.trim() ? { transactionRef: ref.trim() } : {}) : { reason: reason.trim() });
      onChanged(kind === "verify" ? t.slip.verifiedDone : t.slip.rejectedDone);
    } catch (err) {
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="adm-card adm-slip">
      <a href={item.slipUrl} target="_blank" rel="noopener" className="adm-slip__img" aria-label={t.slip.openSlip}>
        <img src={item.slipUrl} alt={format(t.slip.slipAlt, { code: item.bookingCode })} loading="lazy" decoding="async" />
      </a>
      <div className="adm-slip__body">
        <h2 className="adm-h2"><Link to={href("bookings", item.bookingCode)} className="adm-mono">{item.bookingCode}</Link></h2>
        <p className="adm-small">{item.customerName} · {stayDate(item.checkIn)} → {stayDate(item.checkOut)}</p>
        <p>{t.slip.total}: <strong>{formatBaht(item.totalSatang, locale.code)}</strong> · <span className="adm-muted adm-small">{t.slip.submitted} {dateTime(item.submittedAt)}</span></p>
        <h3 className="adm-h3">{t.slip.checks}</h3>
        {item.verifications.length === 0 ? <p className="adm-muted adm-small">{t.slip.noChecks}</p> : (
          <ul className="adm-checks">{item.verifications.map((v, i) => <Check key={i} v={v} />)}</ul>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        {canAct && (
          <div className="adm-slip__actions">
            <form className="adm-inline" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm("verify"); }}>
              <input aria-label={t.slip.txRefInput} placeholder={t.slip.txRefInput} maxLength={64} value={ref} onChange={(e) => setRef(e.target.value)} />
              <Button type="submit" busy={busy}>{t.slip.verify}</Button>
            </form>
            <form className="adm-inline" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm("reject"); }}>
              <input aria-label={t.slip.rejectReason} placeholder={t.slip.rejectReason} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button type="submit" variant="danger" busy={busy}>{t.slip.reject}</Button>
            </form>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirm !== null} danger={confirm === "reject"}
        message={confirm === "reject" ? t.slip.rejectConfirm : t.slip.verifyConfirm}
        confirmLabel={confirm === "reject" ? t.slip.reject : t.slip.verify}
        onCancel={() => setConfirm(null)} onConfirm={() => void act(confirm!)} />
    </article>
  );
}

/** Slip review queue (spec §27). Images are fetched from an authenticated endpoint, never from public storage. */
export function SlipsPage() {
  const { t } = useAdmin();
  const [tab, setTab] = useState<Tab>("PENDING_VERIFICATION");
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const buildUrl = useCallback((before: string | null) => {
    const p = new URLSearchParams({ status: tab, limit: "30" });
    if (before) p.set("before", before);
    void version;
    return `/api/admin/slips?${p}`;
  }, [tab, version]);
  const { items, cursor, loading, error, more } = useCursorList<SlipQueueItemDto>(buildUrl);
  const tabs: { value: Tab; label: string }[] = [
    { value: "PENDING_VERIFICATION", label: t.slip.pending },
    { value: "VERIFIED", label: t.slip.verified },
    { value: "REJECTED", label: t.slip.rejected },
  ];

  return (
    <section>
      <h1 className="adm-h1">{t.slip.title}</h1>
      <div role="tablist" aria-label={t.slip.title} className="adm-tabs">
        {tabs.map((x) => (
          <button key={x.value} role="tab" type="button" aria-selected={tab === x.value} className="adm-tab"
            onClick={() => { setTab(x.value); setMessage(null); }}>{x.label}</button>
        ))}
      </div>
      {message && <Alert kind="success">{message}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {!loading && items.length === 0 && <p className="adm-empty">{t.slip.empty}</p>}
      <div className="adm-slips">
        {items.map((item) => (
          <SlipCard key={item.paymentId} item={item} onChanged={(text) => { setMessage(text); setVersion((v) => v + 1); }} />
        ))}
      </div>
      {loading && <p role="status">{t.common.loading}</p>}
      {cursor && !loading && <Button variant="secondary" onClick={more}>{t.common.loadMore}</Button>}
    </section>
  );
}
