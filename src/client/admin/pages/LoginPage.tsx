import { useState, type FormEvent } from "react";
import type { CurrentUserDto } from "../../../shared/auth-types.ts";
import { LOCALES } from "../../../shared/i18n/locales.ts";
import { adminNextSegments, adminPath } from "../../../shared/routes.ts";
import { apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, errorMessage, Field, PasswordField } from "../ui.tsx";

/** Centered card used by the sign-in / password pages. */
export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  const { locale, t } = useAdmin();
  // Switching language keeps the page to return to (only a valid ?next=, never other query parameters).
  const next = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("next");
  const keep = adminNextSegments(next) ? `?next=${encodeURIComponent(next!)}` : "";
  return (
    <main className="adm-auth" id="adm-main">
      <div className="adm-auth__card">
        <h1 className="adm-auth__title">{title}</h1>
        {children}
      </div>
      <nav className="adm-auth__langs" aria-label={t.common.language}>
        {LOCALES.map((l) => (
          <Link key={l.code} to={`${adminPath(l, "login")}${keep}`} lang={l.code} aria-current={l.code === locale.code ? "true" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
    </main>
  );
}

export function LoginPage({ expired }: { expired: boolean }) {
  const { t, setMe, href } = useAdmin();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await apiRequest<CurrentUserDto>("POST", "/api/auth/login", { identifier: identifier.trim(), password, rememberMe });
      setPassword("");
      setMe(me);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t.auth.loginTitle}>
      {expired && !error && <Alert kind="info">{t.auth.sessionExpired}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={submit} noValidate>
        <Field
          label={t.auth.identifier}
          name="username"
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          maxLength={254}
          autoFocus
        />
        <PasswordField
          label={t.auth.password}
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          maxLength={128}
        />
        <label className="adm-check">
          <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
          {t.auth.rememberMe}
        </label>
        <Button type="submit" busy={busy} className="adm-btn--block" disabled={!identifier || !password}>
          {busy ? t.auth.loggingIn : t.auth.login}
        </Button>
      </form>
      <p className="adm-auth__alt">
        <Link to={href("forgot-password")}>{t.auth.forgotPassword}</Link>
      </p>
    </AuthCard>
  );
}
