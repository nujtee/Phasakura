import { createCenterApp } from "./app.ts";
import type { CenterEnv } from "./env.ts";

/** Center Management console Worker (center/wrangler.jsonc). */
const app = createCenterApp();

export default {
  fetch(request: Request, env: CenterEnv): Promise<Response> {
    return app.fetch(request, env);
  },
};
