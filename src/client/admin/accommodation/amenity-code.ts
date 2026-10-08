/** Amenity codes: 2–40 of a-z, 0-9, _ (the API and the database CHECK enforce the same). */
const CODE = /^[a-z0-9_]{2,40}$/;

function clean(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
}

/**
 * The code to send for a new amenity: what the admin typed (tidied: "Wi-Fi" → "wi_fi"), else one made
 * from the English name, else a random one (a Thai-only name has no Latin letters to use).
 * `auto` = the admin did not choose it, so a clash may be resolved by trying another.
 */
export function amenityCode(typed: string, englishName: string, random: () => string = randomSuffix): { code: string; auto: boolean } {
  const own = clean(typed);
  if (CODE.test(own)) return { code: own, auto: false };
  const fromName = clean(englishName);
  if (CODE.test(fromName)) return { code: fromName, auto: true };
  return { code: `amenity_${random()}`, auto: true };
}

/** Next candidate after a clash of an automatic code: wifi → wifi_2 → wifi_3 … */
export function nextAmenityCode(code: string, attempt: number): string {
  const suffix = `_${attempt + 1}`;
  return `${code.slice(0, 40 - suffix.length)}${suffix}`;
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}
