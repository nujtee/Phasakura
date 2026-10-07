import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import type { AdminMessages } from "../../shared/i18n/admin-messages.ts";
import { ApiError } from "../api/client.ts";
import { useAdmin } from "./AdminContext.tsx";

/** Localised message for an API error (by code), falling back to a generic message. */
export function errorMessage(t: AdminMessages, error: unknown): string {
  if (error instanceof ApiError) {
    const byCode = (t.errors as Record<string, string>)[error.code];
    if (byCode) return byCode;
    if (error.status === 429) return t.errors.TOO_MANY_REQUESTS;
    if (error.status === 403) return t.errors.FORBIDDEN;
    return t.errors.UNKNOWN;
  }
  return t.errors.UNKNOWN;
}

export function fieldErrors(t: AdminMessages, error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const errors = t.errors as Record<string, string>;
  return Object.fromEntries(Object.entries(error.details).map(([field, code]) => [field, errors[code] ?? errors.INVALID_FORMAT!]));
}

/** Most specific message: the first field error's text if any, else the error code's text. */
export function detailMessage(t: AdminMessages, error: unknown): string {
  const first = Object.values(fieldErrors(t, error))[0];
  return first ?? errorMessage(t, error);
}

export function Alert({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  return (
    <div className={`adm-alert adm-alert--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Button({
  variant = "primary",
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean }) {
  return (
    <button type="button" {...rest} className={`adm-btn adm-btn--${variant} ${rest.className ?? ""}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {children}
    </button>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string };

export function Field({ label, error, hint, id, ...input }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className="adm-field">
      <label htmlFor={inputId}>
        {label}
        {input.required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={inputId}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
      />
      {hint && <p id={hintId} className="adm-field__hint">{hint}</p>}
      {error && <p id={errorId} className="adm-field__error">{error}</p>}
    </div>
  );
}

/** Password input with an accessible show/hide toggle (spec §28 "Show Password"). */
export function PasswordField({ label, error, hint, ...input }: FieldProps) {
  const { t } = useAdmin();
  const id = useId();
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="adm-field">
      <label htmlFor={id}>
        {label}
        {input.required && <span aria-hidden="true"> *</span>}
      </label>
      <div className="adm-password">
        <input
          id={id}
          {...input}
          type={visible ? "text" : "password"}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        />
        <button
          type="button"
          className="adm-password__toggle"
          aria-pressed={visible}
          aria-label={visible ? t.common.hidePassword : t.common.showPassword}
          onClick={() => setVisible((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
            {visible && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
          </svg>
        </button>
      </div>
      {hint && <p id={hintId} className="adm-field__hint">{hint}</p>}
      {error && <p id={errorId} className="adm-field__error">{error}</p>}
    </div>
  );
}

/** Accessible modal confirmation using the native <dialog> element (focus trap + Esc built in). */
export function ConfirmDialog({
  open,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useAdmin();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="adm-dialog" onCancel={(e) => { e.preventDefault(); onCancel(); }} aria-label={confirmLabel}>
      <p>{message}</p>
      <div className="adm-dialog__actions">
        <Button variant="secondary" onClick={onCancel}>{t.common.cancel}</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </dialog>
  );
}

export function StatusBadge({ status }: { status: "ACTIVE" | "SUSPENDED" | "DELETED" }) {
  const { t } = useAdmin();
  const label = { ACTIVE: t.users.statusActive, SUSPENDED: t.users.statusSuspended, DELETED: t.users.statusDeleted }[status];
  return <span className={`adm-badge adm-badge--${status.toLowerCase()}`}>{label}</span>;
}

export function useDateFormatter() {
  const { locale } = useAdmin();
  const fmt = new Intl.DateTimeFormat(locale.code, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
  return (iso: string | null | undefined) => (iso ? fmt.format(new Date(iso)) : "—");
}

/** A one-time secret link with a copy button. */
export function OneTimeLink({ title, url, expiresAt }: { title: string; url: string; expiresAt: string }) {
  const { t } = useAdmin();
  const format = useDateFormatter();
  const [copied, setCopied] = useState(false);
  return (
    <div className="adm-onetime" role="status">
      <strong>{title}</strong>
      <div className="adm-onetime__row">
        <input readOnly value={url} aria-label={title} onFocus={(e) => e.currentTarget.select()} />
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? t.common.copied : t.common.copy}
        </Button>
      </div>
      <p className="adm-field__hint">{t.users.linkHint.replace("{expires}", format(expiresAt))}</p>
    </div>
  );
}
