import type { Services } from "../container.ts";
import type { RequestContext } from "../router.ts";
import { clearSessionCookie, readCookie, SESSION_COOKIE } from "../security/cookies.ts";
import { clientIp, userAgent } from "../security/request.ts";
import type { AuthContext, RequestMeta } from "../services/auth-context.ts";
import { ForbiddenError, UnauthorizedError } from "./errors.ts";
import { jsonError } from "./response.ts";

export type ServicesFor = (ctx: RequestContext) => Services;
export type AuthedHandler = (ctx: RequestContext, auth: AuthContext) => Response | Promise<Response>;

export function requestMeta(ctx: RequestContext): RequestMeta {
  return { ip: clientIp(ctx.request), userAgent: userAgent(ctx.request) };
}

/**
 * Wraps a handler so it only runs for an authenticated admin with a valid session.
 * Authorization (permissions) is checked inside the services via AuthorizationService.
 */
export function withAuth(
  services: ServicesFor,
  handler: AuthedHandler,
  options: { allowPasswordChangeRequired?: boolean } = {},
) {
  return async (ctx: RequestContext): Promise<Response> => {
    const token = readCookie(ctx.request, SESSION_COOKIE);
    const auth = await services(ctx).sessions.authenticate(token);
    if (!auth) {
      const res = jsonError(401, "UNAUTHORIZED", new UnauthorizedError().message, ctx.requestId);
      // A stale/invalid cookie is cleared so the browser stops sending it.
      if (token) res.headers.append("Set-Cookie", clearSessionCookie());
      return res;
    }
    if (auth.mustChangePassword && !options.allowPasswordChangeRequired) {
      throw new ForbiddenError("You must change your password before continuing", "PASSWORD_CHANGE_REQUIRED");
    }
    return handler(ctx, auth);
  };
}
