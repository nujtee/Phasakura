import { useState, type FormEvent } from "react";
import { apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, fieldErrors, PasswordField } from "../ui.tsx";
import { AuthCard } from "./LoginPage.tsx";

/**
 * Reads the one-time token from the URL fragment (#token=…), then removes it from the
 * address bar so it isn't left in history, screenshots or shared URLs.
 */
function takeTokenFromHash(): { token: string | null; invite: boolean } {
  if (typeof window === "undefined") return { token: null, invite: false };
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token");
  const invite = params.get("invite") === "1";
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return { token: token && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null, invite };
}

export function ResetPasswordPage() {
  const { t, href } = useAdmin();
  const [{ token, invite }] = useState(takeTokenFromHash);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFields({});
    if (password !== confirm) {
      setFields({ confirm: t.auth.passwordMismatch });
      return;
    }
    setBusy(true);
    try {
      await apiRequest("POST", "/api/auth/reset-password", { token, newPassword: password });
      setDone(true);
    } catch (err) {
      setFields(fieldErrors(t, err));
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={invite ? t.auth.inviteTitle : t.auth.resetTitle}>
      {!token ? (
        <Alert kind="error">{t.auth.resetMissingToken}</Alert>
      ) : done ? (
        <Alert kind="success">{t.auth.resetDone}</Alert>
      ) : (
        <form onSubmit={submit} noValidate>
          {error && <Alert kind="error">{fields.token ?? error}</Alert>}
          <PasswordField label={t.auth.newPassword} autoComplete="new-password" required value={password}
            onChange={(e) => setPassword(e.target.value)} hint={t.auth.passwordHint} error={fields.newPassword} maxLength={128} autoFocus />
          <PasswordField label={t.auth.confirmPassword} autoComplete="new-password" required value={confirm}
            onChange={(e) => setConfirm(e.target.value)} error={fields.confirm} maxLength={128} />
          <Button type="submit" busy={busy} className="adm-btn--block" disabled={!password || !confirm}>{t.common.save}</Button>
        </form>
      )}
      <p className="adm-auth__alt"><Link to={href("login")}>{t.auth.backToLogin}</Link></p>
    </AuthCard>
  );
}
