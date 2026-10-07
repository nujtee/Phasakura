import type { Env, RateLimitBinding } from "../env.ts";

/**
 * Request rate limits per client IP (spec §58 "Rate Limit Abuse", Phase 14), on top of the
 * business limits already in the services (login lockout, bookings per hour, lookup failures,
 * slip uploads). Uses Cloudflare Workers Rate Limiting bindings (`ratelimits` in wrangler.jsonc):
 * counted at the edge, no D1 writes. Without a binding (local dev, tests) requests are allowed.
 *
 *   PUBLIC  pages and public GET APIs (search, availability, content)
 *   WRITE   public POST / PUT / DELETE (booking, quote, slip, lookup, LINE link, search click)
 *   AUTH    /api/auth/* (with the account lockout of Phase 3 behind it)
 *   ADMIN   /api/admin/* (signed-in staff)
 */
export type RateGroup = "PUBLIC" | "WRITE" | "AUTH" | "ADMIN";

const BINDING: Record<RateGroup, keyof Env> = { PUBLIC: "RL_PUBLIC", WRITE: "RL_WRITE", AUTH: "RL_AUTH", ADMIN: "RL_ADMIN" };

export function rateGroup(method: string, path: string): RateGroup | null {
  if (path === "/api/health" || path === "/api/line/webhook") return null; // monitoring; LINE servers (signed)
  if (path.startsWith("/media/") || path.startsWith("/assets/")) return null; // cacheable files
  if (path.startsWith("/api/auth/")) return "AUTH";
  if (path.startsWith("/api/admin/")) return "ADMIN";
  if (method !== "GET" && method !== "HEAD") return "WRITE";
  return "PUBLIC";
}

/** true = allowed. Fails open (an outage of the limiter never takes the site down). */
export async function allowRequest(env: Env, group: RateGroup, ip: string | null): Promise<boolean> {
  const binding = env[BINDING[group]] as RateLimitBinding | undefined;
  if (!binding || !ip) return true;
  try {
    return (await binding.limit({ key: `${group}:${ip}` })).success;
  } catch {
    return true;
  }
}

/** One security event per IP and group per minute per isolate is enough (no log flood under attack). */
const lastLogged = new Map<string, number>();
export function shouldLog(group: RateGroup, ip: string, now = Date.now()): boolean {
  const key = `${group}:${ip}`;
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < 60_000) return false;
  if (lastLogged.size > 5000) lastLogged.clear();
  lastLogged.set(key, now);
  return true;
}
