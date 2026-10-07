import type { Env } from "./env.ts";
import { MethodNotAllowedError, NotFoundError } from "./http/errors.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  requestId: string;
}

export type Handler = (ctx: RequestContext) => Response | Promise<Response>;

interface Route {
  method: HttpMethod;
  segments: string[];
  handler: Handler;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Minimal router: static segments and `:param` segments, no regex, no wildcards.
 * Unknown path → NotFoundError, known path with wrong method → MethodNotAllowedError.
 */
export class Router {
  private readonly routes: Route[] = [];

  on(method: HttpMethod, path: string, handler: Handler): this {
    this.routes.push({ method, segments: splitPath(path), handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.on("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.on("POST", path, handler);
  }

  put(path: string, handler: Handler): this {
    return this.on("PUT", path, handler);
  }

  patch(path: string, handler: Handler): this {
    return this.on("PATCH", path, handler);
  }

  delete(path: string, handler: Handler): this {
    return this.on("DELETE", path, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } {
    const requestSegments = splitPath(pathname);
    const allowed = new Set<string>();

    for (const route of this.routes) {
      const params = matchSegments(route.segments, requestSegments);
      if (!params) continue;
      // HEAD is served by the GET handler.
      if (route.method === method || (method === "HEAD" && route.method === "GET")) {
        return { handler: route.handler, params };
      }
      allowed.add(route.method);
    }

    if (allowed.size > 0) throw new MethodNotAllowedError([...allowed]);
    throw new NotFoundError();
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const a = actual[i]!;
    if (p.startsWith(":")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(a);
      } catch {
        return null;
      }
      params[p.slice(1)] = decoded;
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}
