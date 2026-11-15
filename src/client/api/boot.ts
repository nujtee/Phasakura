/**
 * The page's first data, sent inside the HTML by the Worker (src/worker/seo/prerender.ts): a JSON block keyed by
 * the public API address the app would otherwise request ("/api/public/home?lang=th"). Reading it here saves those
 * round trips, so the first screen is drawn as soon as the script runs.
 *
 * It describes the page as it was when the HTML was made, so it is only used for a short while after load; later
 * requests (another language, a retry, coming back to the page) go to the network as before.
 */

const BOOT_DATA_ID = "boot-data";
/** How long after the page loaded the inline data may answer a request. */
const BOOT_TTL_MS = 30_000;

function read(): Map<string, unknown> {
  try {
    const text = typeof document === "undefined" ? null : document.getElementById(BOOT_DATA_ID)?.textContent;
    if (!text) return new Map();
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

const data = read();
const loadedAt = Date.now();

/** The inline answer for this API path, or null (none sent, or the page has been open for a while). */
export function bootData<T>(path: string): T | null {
  if (!data.size) return null;
  if (Date.now() - loadedAt > BOOT_TTL_MS) { data.clear(); return null; }
  return data.has(path) ? (data.get(path) as T) : null;
}
