import { campaignFromLanding, hasSource, sanitizeCampaign, type CampaignDto } from "../../shared/campaign.ts";

/**
 * First touch of this browser tab (migration 0052): UTM tags, the referring site and the landing page, kept in
 * sessionStorage (this tab only, gone when it closes — no cookie) and sent with the booking. A later page load
 * that carries a real source (tags, another site, an ad click) replaces a plain one; otherwise the first stays.
 */
const KEY = "pk_campaign";

function stored(): CampaignDto | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? sanitizeCampaign(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Called once per page load, before the app renders. Never throws. */
export function captureCampaign(): void {
  try {
    const now = campaignFromLanding(window.location.href, document.referrer, new Date().toISOString());
    if (!now) return;
    const before = stored();
    if (before && (hasSource(before) || !hasSource(now))) return;
    window.sessionStorage.setItem(KEY, JSON.stringify(now));
  } catch {
    // storage blocked (private mode, sandbox): the booking just has no source
  }
}

/** What to send with the booking (undefined when unknown). */
export function readCampaign(): CampaignDto | undefined {
  return stored() ?? undefined;
}
