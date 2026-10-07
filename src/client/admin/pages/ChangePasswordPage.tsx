import { useState, type FormEvent } from "react";
import type { CurrentUserDto } from "../../../shared/auth-types.ts";
import { apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, fieldErrors, PasswordField } from "../ui.tsx";
import { AuthCard } from "./LoginPage.tsx";

export function ChangePasswordPage({ forced }: { forced: boolean }) {
  const { t, setMe, logout } = useAdmin();
  const [current, setCurrent] = useState("");
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
      const me = await apiRequest<CurrentUserDto>("POST", "/api/auth/change-password", {
        currentPassword: current,
        newPassword: password,
      });
      setCurrent("");
      setPassword("");
      setConfirm("");
      setDone(true);
      setMe(me);
    } catch (err) {
      setFields(fieldErrors(t, err));
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <>
      {forced && <Alert kind="info">{t.auth.changeRequired}</Alert>}
      {done && <Alert kind="success">{t.auth.changeDone}</Alert>}
      {error && !done && <Alert kind="error">{error}</Alert>}
      <form onSubmit={submit} noValidate className="adm-form-narrow">
        <PasswordField label={t.auth.currentPassword} autoComplete="current-password" required value={current}
          onChange={(e) => setCurrent(e.target.value)} error={fields.currentPassword} maxLength={128} />
        <PasswordField label={t.auth.newPassword} autoComplete="new-password" required value={password}
          onChange={(e) => setPassword(e.target.value)} hint={t.auth.passwordHint} error={fields.newPassword} maxLength={128} />
        <PasswordField label={t.auth.confirmPassword} autoComplete="new-password" required value={confirm}
          onChange={(e) => setConfirm(e.target.value)} error={fields.confirm} maxLength={128} />
        <Button type="submit" busy={busy} disabled={!current || !password || !confirm}>{t.common.save}</Button>
      </form>
    </>
  );

  if (forced) {
    return (
      <AuthCard title={t.auth.changeTitle}>
        {form}
        <p className="adm-auth__alt">
          <button type="button" className="adm-linkbtn" onClick={() => void logout()}>{t.auth.logout}</button>
        </p>
      </AuthCard>
    );
  }
  return (
    <section>
      <h1 className="adm-h1">{t.auth.changeTitle}</h1>
      {form}
    </section>
  );
}
