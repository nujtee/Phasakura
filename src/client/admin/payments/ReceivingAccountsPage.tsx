import { useEffect, useState, type FormEvent } from "react";
import type { ReceivingAccountDto, ReceivingAccountInput } from "../../../shared/payment-types.ts";
import { apiGet, apiRequest, apiUpload } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, Field, fieldErrors, detailMessage } from "../ui.tsx";

type Draft = ReceivingAccountInput & { qrUrl: string | null };
const EMPTY: Draft = { bankName: "", accountName: "", accountNumber: "", promptpayNumber: "", qrAssetId: null, qrUrl: null, status: "ACTIVE", sortOrder: 0 };

/** Receiving accounts (spec §25). The Worker enforces receiving_accounts.view / .edit. */
export function ReceivingAccountsPage() {
  const { t, can } = useAdmin();
  const [accounts, setAccounts] = useState<ReceivingAccountDto[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const canEdit = can("receiving_accounts.edit");

  const load = () => apiGet<ReceivingAccountDto[]>("/api/admin/receiving-accounts").then(setAccounts)
    .catch((err: unknown) => setMessage({ kind: "error", text: detailMessage(t, err) }));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (err: unknown) => {
    setErrors(fieldErrors(t, err));
    setMessage({ kind: "error", text: detailMessage(t, err) });
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const { qrUrl: _qr, ...body } = editing.draft;
    const payload = { ...body, accountNumber: body.accountNumber?.trim() || null, promptpayNumber: body.promptpayNumber?.trim() || null };
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      if (editing.id) await apiRequest("PATCH", `/api/admin/receiving-accounts/${encodeURIComponent(editing.id)}`, payload);
      else await apiRequest("POST", "/api/admin/receiving-accounts", payload);
      setEditing(null);
      setMessage({ kind: "success", text: t.common.saved });
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function uploadQr(file: File) {
    if (!editing) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("purpose", "PAYMENT_QR");
      const asset = await apiUpload<{ id: string; url: string }>("/api/admin/media", form);
      setEditing({ ...editing, draft: { ...editing.draft, qrAssetId: asset.id, qrUrl: asset.url } });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function act(method: "POST" | "DELETE", path: string) {
    setMessage(null);
    try {
      await apiRequest(method, path);
      setMessage({ kind: "success", text: t.common.saved });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  const set = (patch: Partial<Draft>) => editing && setEditing({ ...editing, draft: { ...editing.draft, ...patch } });

  return (
    <section>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{t.pay.accountsTitle}</h1>
        {canEdit && !editing && <Button onClick={() => { setEditing({ id: null, draft: EMPTY }); setErrors({}); }}>+ {t.pay.newAccount}</Button>}
      </div>
      <p className="adm-muted">{t.pay.accountsIntro}</p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      {editing && (
        <form className="adm-card" onSubmit={(e) => void save(e)}>
          <h2 className="adm-h2">{editing.id ? t.pay.edit : t.pay.newAccount}</h2>
          <div className="adm-grid2">
            <Field label={t.pay.bankName} required maxLength={80} value={editing.draft.bankName} error={errors.bankName}
              onChange={(e) => set({ bankName: e.target.value })} />
            <Field label={t.pay.accountName} required maxLength={120} value={editing.draft.accountName} error={errors.accountName}
              onChange={(e) => set({ accountName: e.target.value })} />
            <Field label={t.pay.accountNumber} inputMode="numeric" maxLength={24} value={editing.draft.accountNumber ?? ""} error={errors.accountNumber}
              placeholder="123-4-56789-0" onChange={(e) => set({ accountNumber: e.target.value })} />
            <Field label={t.pay.promptpay} inputMode="numeric" maxLength={20} value={editing.draft.promptpayNumber ?? ""} error={errors.promptpayNumber}
              onChange={(e) => set({ promptpayNumber: e.target.value })} />
          </div>
          <div className="adm-field">
            <span className="adm-label">{t.pay.qr}</span>
            <div className="adm-qr">
              {editing.draft.qrUrl && <img src={editing.draft.qrUrl} alt="" width={120} height={120} />}
              <label className="adm-btn adm-btn--secondary">
                {t.pay.uploadQr}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="visually-hidden" id="qr-upload"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadQr(f); e.target.value = ""; }} />
              </label>
              {editing.draft.qrAssetId && <Button variant="ghost" onClick={() => set({ qrAssetId: null, qrUrl: null })}>{t.pay.removeQr}</Button>}
            </div>
            {errors.qrAssetId && <p className="adm-field__error">{errors.qrAssetId}</p>}
          </div>
          <div className="adm-field">
            <label htmlFor="acc-status">{t.pricing.status}</label>
            <select id="acc-status" value={editing.draft.status} onChange={(e) => set({ status: e.target.value as "ACTIVE" | "INACTIVE" })}>
              <option value="ACTIVE">{t.pay.active}</option>
              <option value="INACTIVE">{t.pay.inactive}</option>
            </select>
          </div>
          <div className="adm-row">
            <Button type="submit" busy={busy}>{busy ? t.common.saving : t.common.save}</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
          </div>
        </form>
      )}

      {!accounts && <p role="status">{t.common.loading}</p>}
      {accounts && accounts.length === 0 && <p className="adm-empty">{t.pay.empty}</p>}
      <div className="adm-accounts">
        {accounts?.map((a) => (
          <article key={a.id} className={`adm-card adm-account ${a.isPrimary ? "is-primary" : ""}`}>
            {a.qrUrl ? <img className="adm-account__qr" src={a.qrUrl} alt="" width={96} height={96} /> : <div className="adm-account__qr adm-account__qr--none" aria-hidden="true">QR</div>}
            <div className="adm-account__body">
              <h2 className="adm-h2">
                {a.bankName}{" "}
                {a.isPrimary && <span className="adm-badge adm-badge--active">{t.pay.primary}</span>}
                {a.status === "INACTIVE" && <span className="adm-badge adm-badge--deleted">{t.pay.inactive}</span>}
              </h2>
              <p className="adm-small">{a.accountName}</p>
              {a.accountNumber && <p className="adm-mono">{t.pay.accountNumber}: {a.accountNumber}</p>}
              {a.promptpayNumber && <p className="adm-mono">{t.pay.promptpay.split(" (")[0]}: {a.promptpayNumber}</p>}
              {canEdit && (
                <div className="adm-row adm-row--wrap">
                  <Button variant="secondary" onClick={() => {
                    setEditing({ id: a.id, draft: { bankName: a.bankName, accountName: a.accountName, accountNumber: a.accountNumber, promptpayNumber: a.promptpayNumber, qrAssetId: a.qrAssetId, qrUrl: a.qrUrl, status: a.status, sortOrder: a.sortOrder } });
                    setErrors({});
                    window.scrollTo({ top: 0 });
                  }}>{t.pay.edit}</Button>
                  {!a.isPrimary && a.status === "ACTIVE" && (
                    <Button variant="secondary" onClick={() => void act("POST", `/api/admin/receiving-accounts/${encodeURIComponent(a.id)}/primary`)}>{t.pay.makePrimary}</Button>
                  )}
                  {!a.isPrimary && <Button variant="ghost" onClick={() => setDeleting(a.id)}>{t.pay.delete}</Button>}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
      <ConfirmDialog open={deleting !== null} danger message={t.pay.deleteConfirm} confirmLabel={t.pay.delete}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { const id = deleting!; setDeleting(null); void act("DELETE", `/api/admin/receiving-accounts/${encodeURIComponent(id)}`); }} />
    </section>
  );
}
