import { parseLocale } from "../../shared/i18n/locales.ts";
import { requestMeta, withAuth, type ServicesFor } from "../http/auth-guard.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler } from "../router.ts";
import { clearSessionCookie } from "../security/cookies.ts";
import { PASSWORD_MAX_LENGTH } from "../security/password.ts";
import { readJsonObject } from "../security/request.ts";
import { toCurrentUser } from "../services/auth.service.ts";
import { Validator } from "../validation.ts";

export function authController(services: ServicesFor) {
  return {
    /** POST /api/auth/login */
    login: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["identifier", "password", "rememberMe"]);
      const identifier = v.string("identifier", { required: true, max: 254 });
      const password = v.string("password", { required: true, max: PASSWORD_MAX_LENGTH, raw: true });
      const rememberMe = v.boolean("rememberMe", false);
      v.assertValid();

      const s = services(ctx);
      const { session, user } = await s.auth.login({ identifier, password, rememberMe }, requestMeta(ctx));
      return jsonOk(user, { headers: { "Set-Cookie": s.sessions.cookie(session) } });
    }) satisfies Handler,

    /** POST /api/auth/logout */
    logout: withAuth(services, async (ctx, auth) => {
      await services(ctx).auth.logout(auth, requestMeta(ctx));
      return jsonOk({ loggedOut: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
    }, { allowPasswordChangeRequired: true }),

    /** GET /api/auth/me */
    me: withAuth(services, (_ctx, auth) => jsonOk(toCurrentUser(auth)), { allowPasswordChangeRequired: true }),

    /** POST /api/auth/refresh — rotates the session token. */
    refresh: withAuth(services, async (ctx, auth) => {
      const s = services(ctx);
      const next = await s.auth.refresh(auth, requestMeta(ctx));
      const refreshed = await s.sessions.authenticate(next.token);
      return jsonOk(refreshed ? toCurrentUser(refreshed) : null, { headers: { "Set-Cookie": s.sessions.cookie(next) } });
    }, { allowPasswordChangeRequired: true }),

    /** POST /api/auth/forgot-password — always 202, never reveals whether the email exists. */
    forgotPassword: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["email", "language"]);
      const email = v.email("email", { required: true });
      const language = v.string("language", { max: 10 });
      v.assertValid();
      await services(ctx).auth.forgotPassword(email, parseLocale(language)?.code ?? null, requestMeta(ctx));
      return jsonOk({ accepted: true }, { status: 202 });
    }) satisfies Handler,

    /** POST /api/auth/reset-password */
    resetPassword: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["token", "newPassword"]);
      const token = v.string("token", { required: true, pattern: /^[A-Za-z0-9_-]{20,100}$/ });
      const newPassword = v.string("newPassword", { required: true, max: PASSWORD_MAX_LENGTH, raw: true });
      v.assertValid();
      await services(ctx).auth.resetPassword(token, newPassword, requestMeta(ctx));
      return jsonOk({ reset: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
    }) satisfies Handler,

    /** POST /api/auth/change-password */
    changePassword: withAuth(services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["currentPassword", "newPassword"]);
      const currentPassword = v.string("currentPassword", { required: true, max: PASSWORD_MAX_LENGTH, raw: true });
      const newPassword = v.string("newPassword", { required: true, max: PASSWORD_MAX_LENGTH, raw: true });
      v.assertValid();
      const s = services(ctx);
      const next = await s.auth.changePassword(auth, currentPassword, newPassword, requestMeta(ctx));
      const refreshed = await s.sessions.authenticate(next.token);
      return jsonOk(refreshed ? toCurrentUser(refreshed) : null, { headers: { "Set-Cookie": s.sessions.cookie(next) } });
    }, { allowPasswordChangeRequired: true }),
  };
}
