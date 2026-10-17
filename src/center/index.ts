import { createCenterApp } from "./app.ts";
import type { CenterEnv } from "./env.ts";
import { runChecks } from "./monitor.ts";

/** Center Management console Worker (center/wrangler.jsonc). */
const app = createCenterApp();

export default {
  fetch(request: Request, env: CenterEnv): Promise<Response> {
    return app.fetch(request, env);
  },
  /** Every 5 minutes (phase C5): check every site, announce what changed in the LINE group. */
  async scheduled(_event: unknown, env: CenterEnv): Promise<void> {
    try {
      const r = await runChecks(env);
      if (r.events.length) console.warn(JSON.stringify({ level: "warn", message: "center_alert_events", events: r.events.length, delivery: r.delivery }));
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "center_checks_failed", error: String(error).slice(0, 300) }));
    }
  },
};
