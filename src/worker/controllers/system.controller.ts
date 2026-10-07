import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { jsonOk } from "../http/response.ts";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Admin → System status (Phase 16, `system.view`). */
export function systemController(services: ServicesFor) {
  return {
    status: withPermission("system.view", services, async (ctx, auth) => jsonOk(await services(ctx).monitoring.status(auth, requestMeta(ctx)), NO_STORE)),
  };
}
