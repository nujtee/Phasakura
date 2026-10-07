import type { FetchLike } from "../line/line-api.ts";

/**
 * Meta Conversions API client (spec §45). The access token travels only in the request body to
 * graph.facebook.com; it is never logged, stored or put in a URL, and any echo of it in an error
 * message is removed before the message is kept.
 */
export interface CapiEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: "website";
  event_source_url?: string;
  user_data: {
    client_user_agent?: string;
    client_ip_address?: string;
    fbp?: string;
    fbc?: string;
    external_id?: string[];
  };
  custom_data?: Record<string, unknown>;
}

export interface CapiConfig {
  token: string;
  pixelId: string;
  version: string;
  testEventCode: string | null;
  fetch?: FetchLike;
}

export type CapiResult = { ok: true; received: number } | { ok: false; retry: boolean; error: string };

export const DEFAULT_GRAPH_VERSION = "v23.0";
const TIMEOUT_MS = 10_000;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function scrub(message: string, secrets: (string | null | undefined)[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out.replace(/access_token=[^&\s"]+/g, "access_token=[redacted]").slice(0, 300);
}

export async function sendCapiEvent(cfg: CapiConfig, event: CapiEvent): Promise<CapiResult> {
  const doFetch = cfg.fetch ?? ((input, init) => fetch(input, init));
  const version = /^v\d{1,3}\.\d$/.test(cfg.version) ? cfg.version : DEFAULT_GRAPH_VERSION;
  if (!/^\d{5,20}$/.test(cfg.pixelId)) return { ok: false, retry: false, error: "Invalid Pixel ID" };
  const body = JSON.stringify({
    data: [event],
    ...(cfg.testEventCode ? { test_event_code: cfg.testEventCode } : {}),
    access_token: cfg.token,
  });
  let res: Response;
  try {
    res = await doFetch(`https://graph.facebook.com/${version}/${cfg.pixelId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
    return { ok: false, retry: true, error: timeout ? "TIMEOUT" : "NETWORK" };
  }
  const json = (await res.json().catch(() => null)) as { events_received?: number; error?: { message?: string; code?: number } } | null;
  if (res.ok && typeof json?.events_received === "number") return { ok: true, received: json.events_received };
  const detail = scrub(`HTTP ${res.status}${json?.error?.code ? ` code ${json.error.code}` : ""}: ${json?.error?.message ?? res.statusText}`, [cfg.token]);
  // 429 / 5xx are temporary; any other 4xx (bad token = code 190, bad pixel, bad payload) will not fix itself.
  return { ok: false, retry: res.status === 429 || res.status >= 500, error: detail };
}
