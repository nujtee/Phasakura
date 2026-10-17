/**
 * Center ↔ site protocol (Center Management phase C2).
 *
 * Center holds an Ed25519 private key; every site holds only the public key(s) in the plain var
 * CENTER_PUBLIC_KEYS (`{"<keyId>":"<32-byte public key, base64url>"}`). Center signs every request to
 * `https://<site>/api/center/*`; a site accepts it only when the signature, time, nonce and host all check
 * out. The same file signs (Center, tests) and verifies (site), so both ends always agree on the bytes.
 *
 * Canonical string (one field per line, "\n" separated, no trailing newline):
 *   CENTER-V1
 *   <METHOD>                 GET, POST… (upper case)
 *   <host>                   the site's host, lower case — a request signed for chomkhao.com is refused by phasakura.com
 *   <path + query>           exactly as sent, e.g. /api/center/status
 *   <unix seconds>           X-Center-Time
 *   <nonce>                  X-Center-Nonce (16–64 of A-Z a-z 0-9 _ -), used once
 *   <actor>                  X-Center-Actor, as sent (base64url JSON of the Center user, see CenterActor)
 *   <sha256 hex of the body> empty body → sha256("")
 */

export const CENTER_API_VERSION = 1;
export const CENTER_SIGNATURE_VERSION = "CENTER-V1";
/** How far the request time may be from the site's clock. */
export const CENTER_MAX_SKEW_SECONDS = 60;
/** Nonces are remembered at least this long (> 2 × skew) so a replay inside the window is always caught. */
export const CENTER_NONCE_TTL_SECONDS = 300;

export const CENTER_HEADERS = {
  keyId: "X-Center-Key",
  time: "X-Center-Time",
  nonce: "X-Center-Nonce",
  actor: "X-Center-Actor",
  signature: "X-Center-Signature",
} as const;

export const CENTER_ROLES = ["PLATFORM_OWNER", "OPERATOR", "SUPPORT_READONLY"] as const;
/** Bytes backed by a plain ArrayBuffer (what WebCrypto accepts). */
export type Bytes = Uint8Array<ArrayBuffer>;

export type CenterRole = (typeof CENTER_ROLES)[number];

/** Who in Center sent the request (echoed into the site's audit log for anything that changes data). */
export interface CenterActor {
  /** Center user id. */
  id: string;
  email: string;
  role: CenterRole;
  /** Why (required by the site for every write, phase C3). */
  reason?: string;
}

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidNonce(nonce: string): boolean {
  return NONCE.test(nonce);
}

export function isValidKeyId(keyId: string): boolean {
  return KEY_ID.test(keyId);
}

export function canonicalString(input: {
  method: string; host: string; pathAndQuery: string; time: number | string; nonce: string; actor: string; bodySha256: string;
}): string {
  return [
    CENTER_SIGNATURE_VERSION, input.method.toUpperCase(), input.host.toLowerCase(), input.pathAndQuery,
    String(input.time), input.nonce, input.actor, input.bodySha256,
  ].join("\n");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** null when the text is not base64url. */
export function base64UrlDecode(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeActor(actor: CenterActor): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(actor)));
}

/** The actor header, or null when it is missing, malformed or carries an unknown role. */
export function decodeActor(header: string): CenterActor | null {
  const bytes = base64UrlDecode(header);
  if (!bytes || bytes.length > 1024) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.id)) return null;
    if (typeof v.email !== "string" || v.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(v.email)) return null;
    if (typeof v.role !== "string" || !(CENTER_ROLES as readonly string[]).includes(v.role)) return null;
    if (v.reason !== undefined && (typeof v.reason !== "string" || v.reason.length > 300)) return null;
    return { id: v.id, email: v.email, role: v.role as CenterRole, ...(v.reason !== undefined ? { reason: v.reason as string } : {}) };
  } catch {
    return null;
  }
}

export async function sha256Hex(data: Bytes | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Headers for one signed request (Center side; tests). `privateKey` = an Ed25519 CryptoKey with "sign".
 * `url` is the full https URL of the site endpoint; `body` the exact bytes that will be sent.
 */
export async function signCenterRequest(input: {
  privateKey: CryptoKey; keyId: string; method: string; url: string; actor: CenterActor;
  body?: Bytes | string; now?: Date; nonce?: string;
}): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const time = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const nonce = input.nonce ?? base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));
  const actor = encodeActor(input.actor);
  const body = input.body === undefined ? new Uint8Array() : typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
  const message = canonicalString({
    method: input.method, host: url.host, pathAndQuery: url.pathname + url.search, time, nonce, actor, bodySha256: await sha256Hex(body),
  });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, input.privateKey, new TextEncoder().encode(message)));
  return {
    [CENTER_HEADERS.keyId]: input.keyId,
    [CENTER_HEADERS.time]: String(time),
    [CENTER_HEADERS.nonce]: nonce,
    [CENTER_HEADERS.actor]: actor,
    [CENTER_HEADERS.signature]: base64UrlEncode(signature),
  };
}

/** Parses CENTER_PUBLIC_KEYS. Invalid JSON or entries are skipped (an empty map = the Center API is off). */
export function parseCenterPublicKeys(value: string | undefined): Map<string, Bytes> {
  const keys = new Map<string, Bytes>();
  if (!value?.trim()) return keys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return keys;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return keys;
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidKeyId(id) || typeof raw !== "string") continue;
    const bytes = base64UrlDecode(raw);
    if (bytes?.length === 32) keys.set(id, bytes);
  }
  return keys;
}
