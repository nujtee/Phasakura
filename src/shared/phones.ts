/**
 * The site's contact numbers: owners often have more than one ("063-795-1218, 095-579-0679").
 * A comma (also the full-width "，" / "、"), semicolon, slash or new line separates them; they are stored joined by ", ".
 */
export const MAX_SITE_PHONES = 5;

export function splitPhones(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/[,;/\n，、]+/).map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** tel: link for one number (digits and a leading +). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}
