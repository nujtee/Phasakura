import { addDays, isIsoDate } from "../../shared/dates.ts";

/**
 * iCalendar (RFC 5545) — just what calendar sync with Booking.com / Agoda / Airbnb needs (phase O1):
 * reading their VEVENTs as stay nights, and writing ours as all-day "not available" events.
 * A VEVENT's DTEND is exclusive, exactly like a check-out day: [DTSTART, DTEND) are the nights.
 */

export interface IcsEvent {
  uid: string | null;
  /** First night (YYYY-MM-DD). */
  start: string;
  /** Check-out day, exclusive (YYYY-MM-DD). */
  end: string;
  summary: string | null;
}

/** More than any real calendar of one room; a bigger file is refused rather than half read. */
export const ICS_MAX_EVENTS = 5000;
/** A stay longer than this is not a booking (and would block a year at once). */
const MAX_EVENT_NIGHTS = 400;

export class IcsError extends Error {}

/** Parses an .ics file; throws IcsError when it is not a calendar. Unreadable events are skipped. */
export function parseIcs(text: string): IcsEvent[] {
  // Unfold (CRLF / LF followed by a space or tab continues the previous line).
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  if (!lines.some((l) => /^BEGIN:VCALENDAR\s*$/i.test(l))) throw new IcsError("NOT_A_CALENDAR");
  const events: IcsEvent[] = [];
  let current: Record<string, { params: string; value: string }> | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^BEGIN:VEVENT$/i.test(line)) { current = {}; continue; }
    if (/^END:VEVENT$/i.test(line)) {
      if (current) {
        const event = toEvent(current);
        if (event) events.push(event);
        if (events.length > ICS_MAX_EVENTS) throw new IcsError("TOO_MANY_EVENTS");
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!.toUpperCase();
    if (!(name in current)) current[name] = { params: m[2] ?? "", value: m[3] ?? "" };
  }
  return events;
}

function toEvent(p: Record<string, { params: string; value: string }>): IcsEvent | null {
  if ((p.STATUS?.value ?? "").toUpperCase() === "CANCELLED") return null;
  const start = icsDate(p.DTSTART?.value);
  if (!start) return null;
  let end = icsDate(p.DTEND?.value);
  if (!end && p.DURATION) {
    const days = /^P(?:(\d+)W)?(?:(\d+)D)?/.exec(p.DURATION.value);
    const n = days ? Number(days[1] ?? 0) * 7 + Number(days[2] ?? 0) : 0;
    end = n > 0 ? addDays(start, n) : null;
  }
  // An event without an end (or ending the same day) holds its first night.
  if (!end || end <= start) end = addDays(start, 1);
  if (addDays(start, MAX_EVENT_NIGHTS) < end) end = addDays(start, MAX_EVENT_NIGHTS);
  return { uid: p.UID?.value.slice(0, 200) || null, start, end, summary: p.SUMMARY ? unescapeText(p.SUMMARY.value).slice(0, 200) : null };
}

/** "20270201" or "20270201T140000Z" → "2027-02-01" (the calendar day as written; OTAs send all-day dates). */
function icsDate(value: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value?.trim() ?? "");
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(date) ? date : null;
}

/** Every night the events hold inside [from, toExclusive). */
export function nightsOf(events: IcsEvent[], from: string, toExclusive: string): Set<string> {
  const nights = new Set<string>();
  for (const e of events) {
    for (let d = e.start < from ? from : e.start; d < e.end && d < toExclusive; d = addDays(d, 1)) nights.add(d);
  }
  return nights;
}

/** Sorted nights → [start, end) runs of consecutive nights. */
export function rangesOf(nights: Iterable<string>): { start: string; end: string }[] {
  const sorted = [...new Set(nights)].sort();
  const out: { start: string; end: string }[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === d) last.end = addDays(d, 1);
    else out.push({ start: d, end: addDays(d, 1) });
  }
  return out;
}

/** Our calendar for one unit: one all-day event per run of unavailable nights, no guest data at all. */
export function buildIcs(input: { name: string; uidPrefix: string; host: string; ranges: { start: string; end: string }[]; now: Date }): string {
  const stamp = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Phasakura//Booking calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(input.name)}`,
  ];
  for (const r of input.ranges) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${input.uidPrefix}-${r.start.replace(/-/g, "")}@${input.host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${r.start.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${r.end.replace(/-/g, "")}`,
      "SUMMARY:Not available",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, " ").replace(/\\([\\;,])/g, "$1");
}

/** Lines of at most 75 octets (RFC 5545 §3.1), continued with a leading space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let chunk = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (parts.length ? 74 : 75)) { parts.push(chunk); chunk = ""; size = 0; }
    chunk += ch;
    size += n;
  }
  parts.push(chunk);
  return parts.join("\r\n ");
}
