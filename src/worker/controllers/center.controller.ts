import { CENTER_API_VERSION } from "../../shared/center-protocol.ts";
import type { Services } from "../container.ts";
import { requestMeta } from "../http/auth-guard.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { LATEST_MIGRATION } from "../services/health.service.ts";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * /api/center/* — what Center Management may ask a site (phase C2). Every handler first verifies the
 * Ed25519 signature (CenterAccessService); reads are not written to the audit log (Center polls every
 * few minutes), refusals are security events. Writes arrive in phase C3 and are audited with the actor.
 */
export function centerController(services: (ctx: Pick<RequestContext, "request" | "env" | "url">) => Services) {
  return {
    /** Handshake: which site this is, which API and schema it speaks. */
    hello: (async (ctx) => {
      const s = services(ctx);
      const { actor } = await s.center.verify(ctx.request, ctx.url, requestMeta(ctx));
      const health = await s.health.check();
      return jsonOk({
        apiVersion: CENTER_API_VERSION,
        site: { host: ctx.url.host, baseUrl: ctx.env.APP_BASE_URL?.trim() || null, environment: ctx.env.APP_ENV },
        schema: { expected: LATEST_MIGRATION, status: health.schema },
        time: health.time,
        actor: { id: actor.id, role: actor.role },
      }, NO_STORE);
    }) satisfies Handler,

    /** The back office's System status (health, readiness checks, cron, backlog, recent errors). */
    status: (async (ctx) => {
      const s = services(ctx);
      await s.center.verify(ctx.request, ctx.url, requestMeta(ctx));
      return jsonOk({ apiVersion: CENTER_API_VERSION, ...(await s.monitoring.snapshot()) }, NO_STORE);
    }) satisfies Handler,
  };
}
