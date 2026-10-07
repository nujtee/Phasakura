import { useState, type FormEvent } from "react";
import { apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, Field } from "../ui.tsx";
import { AuthCard } from "./LoginPage.tsx";

export function ForgotPasswordPage() {
  const { t, href, locale } = useAdmin();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/auth/forgot-password", { email: email.trim(), language: locale.code });
      setSent(true);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t.auth.forgotTitle}>
      {sent ? (
        <Alert kind="success">{t.auth.forgotSent}</Alert>
      ) : (
        <>
          <p className="adm-muted">{t.auth.forgotHelp}</p>
          {error && <Alert kind="error">{error}</Alert>}
          <form onSubmit={submit} noValidate>
            <Field label={t.auth.email} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoFocus />
            <Button type="submit" busy={busy} className="adm-btn--block" disabled={!email}>{t.auth.sendLink}</Button>
          </form>
        </>
      )}
      <p className="adm-auth__alt"><Link to={href("login")}>{t.auth.backToLogin}</Link></p>
    </AuthCard>
  );
}
