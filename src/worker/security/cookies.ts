/**
 * Session cookie.
 * `__Host-` prefix: browser only accepts it with Secure, Path=/ and no Domain,
 * so it cannot be set or overwritten by a subdomain.
 * Browsers treat http://localhost as secure, so this works with `wrangler dev`.
 */
export const SESSION_COOKIE = "__Host-sid";

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** @param maxAgeSeconds undefined → browser-session cookie (cleared on browser close). */
export function sessionCookie(token: string, maxAgeSeconds?: number): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "Secure", "SameSite=Strict"];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
