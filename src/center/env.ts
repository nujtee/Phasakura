import type { D1DatabaseLike } from "../worker/env.ts";

/** A service binding to a site's Worker (Center reaches every site this way, never over the public internet). */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/** Bindings of the Center Worker (center/wrangler.jsonc, generated from sites/sites.json). */
export interface CenterEnv {
  DB: D1DatabaseLike;
  /** https://center.phasakura.com */
  APP_BASE_URL?: string;
  /** JSON [{ slug, name, domain, binding }] — every site in the registry. */
  CENTER_SITES?: string;
  /** Secret "<keyId>:<PKCS#8 Ed25519 private key, base64url>" — set only by Actions → Center keys. */
  CENTER_SIGNING_KEY?: string;
  /** Secrets of Center's own LINE Official Account (Messaging API channel) for system alerts (phase C5). */
  CENTER_LINE_TOKEN?: string;
  CENTER_LINE_SECRET?: string;
  /** Release from Center (phase C8): "owner/repo" (var) and a fine-grained token with Actions read/write on it (secret). */
  CENTER_GITHUB_REPO?: string;
  CENTER_GITHUB_TOKEN?: string;
  /** SITE_<SLUG> service bindings. */
  [binding: string]: unknown;
}

export interface CenterSite {
  slug: string;
  name: string;
  domain: string;
  binding: string;
}

export function parseSites(raw: string | undefined): CenterSite[] {
  if (!raw?.trim()) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((s): s is CenterSite =>
      !!s && typeof s === "object" && typeof s.slug === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(s.slug)
      && typeof s.name === "string" && typeof s.domain === "string" && /^[a-z0-9.-]+$/.test(s.domain) && typeof s.binding === "string");
  } catch {
    return [];
  }
}
