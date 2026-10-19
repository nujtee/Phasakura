import qrcode from "qrcode-generator";

/**
 * Two-step sign-in for Center (phase C9): TOTP as in RFC 6238 — HMAC-SHA1, 30-second steps, 6 digits — which every
 * authenticator app (Google / Microsoft Authenticator, 1Password, Authy…) speaks. One step either side is accepted
 * for clock drift; a step is never accepted twice (totp_last_step).
 */
export const TOTP_PERIOD_S = 30;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]+$/.test(clean)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 20 random bytes (160 bits, as RFC 4226 recommends) as base32 — 32 characters. */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_S);
}

export async function totpCode(secret: string, step: number): Promise<string> {
  const key = base32Decode(secret);
  if (!key) throw new Error("bad TOTP secret");
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, counter));
  const offset = mac[mac.length - 1]! & 15;
  const bin = ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The matched time step, or null. Steps at or before `lastStep` are refused (no replay). */
export async function verifyTotp(secret: string, code: string, now: Date, lastStep: number | null): Promise<number | null> {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = stepAt(now);
  for (const step of [current, current - 1, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = await totpCode(secret, step);
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= expected.charCodeAt(i) ^ digits.charCodeAt(i);
    if (diff === 0) return step;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD_S}`;
}

/** The URI as an inline SVG QR code (no script, no external image — fits Center's strict CSP). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/** Ten one-time recovery codes, e.g. "k7wq-3mzp". */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const s = base32Encode(crypto.getRandomValues(new Uint8Array(5))).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}

export function normalizeRecoveryCode(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/[\s-]/g, "");
  return /^[a-z2-7]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}
