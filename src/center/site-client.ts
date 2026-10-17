import { base64UrlDecode, signCenterRequest, type CenterActor } from "../shared/center-protocol.ts";
import type { CenterEnv, CenterSite, Fetcher } from "./env.ts";

export interface SiteResponse<T> {
  /** HTTP status; 0 = the site could not be reached (no binding, timeout, network). */
  status: number;
  data?: T;
  error?: { code: string; message?: string };
}

const keyCache = new Map<string, Promise<{ keyId: string; key: CryptoKey } | null>>();

/** The signing key from CENTER_SIGNING_KEY ("<keyId>:<pkcs8 base64url>"), imported once per isolate. null = not set / invalid. */
export function signingKey(secret: string | undefined): Promise<{ keyId: string; key: CryptoKey } | null> {
  const value = secret?.trim() ?? "";
  let cached = keyCache.get(value);
  if (!cached) {
    cached = (async () => {
      const match = /^([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]+)$/.exec(value);
      const der = match ? base64UrlDecode(match[2]!) : null;
      if (!match || !der) return null;
      try {
        return { keyId: match[1]!, key: await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]) };
      } catch {
        return null;
      }
    })();
    keyCache.set(value, cached);
  }
  return cached;
}

/**
 * Signed calls from Center to a site's /api/center/* (protocol: src/shared/center-protocol.ts). The request URL is
 * https://<site domain>/…, so the host in the signature is the site's own; it travels over the site's service binding.
 */
export class SiteClient {
  constructor(private readonly env: CenterEnv, private readonly timeoutMs = 8000, private readonly clock: () => Date = () => new Date()) {}

  async call<T>(site: CenterSite, method: "GET" | "POST" | "PUT", path: string, actor: CenterActor, body?: unknown): Promise<SiteResponse<T>> {
    const binding = this.env[site.binding] as Fetcher | undefined;
    if (!binding || typeof binding.fetch !== "function") return { status: 0, error: { code: "NO_BINDING", message: `service binding ${site.binding} is missing` } };
    const key = await signingKey(this.env.CENTER_SIGNING_KEY);
    if (!key) return { status: 0, error: { code: "NO_SIGNING_KEY", message: "CENTER_SIGNING_KEY is not set (Actions → Center keys)" } };
    const url = `https://${site.domain}${path}`;
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signCenterRequest({ privateKey: key.key, keyId: key.keyId, method, url, actor, body: raw, now: this.clock() });
    try {
      const res = await binding.fetch(new Request(url, {
        method, body: raw,
        headers: { ...headers, ...(raw ? { "Content-Type": "application/json" } : {}), "User-Agent": "phasakura-center/1" },
        signal: AbortSignal.timeout(this.timeoutMs),
      }));
      const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message?: string } };
      return { status: res.status, data: json.data, error: json.error ?? (res.ok ? undefined : { code: `HTTP_${res.status}` }) };
    } catch (error) {
      return { status: 0, error: { code: "UNREACHABLE", message: String(error).slice(0, 200) } };
    }
  }
}
