/**
 * Password hashing with PBKDF2-HMAC-SHA256 via WebCrypto.
 *
 * Format (PHC-like, self-describing so parameters can be upgraded later):
 *   pbkdf2_sha256$<iterations>$<salt base64url>$<hash base64url>
 *
 * 100,000 iterations is the maximum Cloudflare Workers allows for PBKDF2.
 * Hashes with fewer iterations are transparently re-hashed on next login.
 */
import { base64UrlDecode, base64UrlEncode, timingSafeEqual } from "./tokens.ts";

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PREFIX = "pbkdf2_sha256";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${PREFIX}$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return null;
  try {
    const salt = base64UrlDecode(parts[2]!);
    const hash = base64UrlDecode(parts[3]!);
    if (salt.length < 8 || hash.length !== HASH_BYTES) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(candidate, parsed.hash);
}

export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.iterations < PBKDF2_ITERATIONS;
}

/**
 * A fixed, valid hash of a random value. Verifying against it when the user does
 * not exist keeps response time similar, so timing does not reveal valid accounts.
 */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))));
  return dummyHash;
}

export type PasswordPolicyError = "TOO_SHORT" | "TOO_LONG" | "CONTAINS_IDENTIFIER" | "TOO_COMMON" | "TOO_SIMPLE";

const COMMON = new Set([
  "password1234", "123456789012", "qwertyuiop12", "passwordpassword", "adminadmin12", "welcome12345",
  "iloveyou1234", "abcdefghijkl", "111111111111", "000000000000", "letmein12345", "changeme1234",
]);

/** Length-first policy (NIST SP 800-63B): long passphrases, no forced symbol rules. */
export function validatePasswordPolicy(password: string, identifiers: string[] = []): PasswordPolicyError | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return "TOO_SHORT";
  if (length > PASSWORD_MAX_LENGTH) return "TOO_LONG";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "TOO_COMMON";
  if (new Set(lower).size < 5) return "TOO_SIMPLE";
  for (const id of identifiers) {
    const local = id.toLowerCase().split("@")[0] ?? "";
    if (local.length >= 4 && lower.includes(local)) return "CONTAINS_IDENTIFIER";
  }
  return null;
}
