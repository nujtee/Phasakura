import type { Services } from "../container.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler } from "../router.ts";

export function healthController(services: (ctx: Parameters<Handler>[0]) => Services) {
  return {
    /** GET /api/health — liveness + D1 reachability. Exposes no configuration. */
    check: (async (ctx) => {
      const health = await services(ctx).health.check();
      return jsonOk(health, { status: health.status === "ok" ? 200 : 503 });
    }) satisfies Handler,
  };
}
