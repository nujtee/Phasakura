import type { LocaleCode } from "./i18n/locales.ts";

/** OTA channels (phase O1, migration 0033). iCal calendar sync is per house / VIP tent and per channel. */
/** OTHER = any other OTA that offers an iCal link; staff name it (label). */
export const ICAL_CHANNELS = ["BOOKING", "AGODA", "AIRBNB", "VRBO", "OTHER"] as const;
export type IcalChannel = (typeof ICAL_CHANNELS)[number];

export const ICAL_CHANNEL_NAMES: Record<IcalChannel, string> = { BOOKING: "Booking.com", AGODA: "Agoda", AIRBNB: "Airbnb", VRBO: "Vrbo", OTHER: "Other OTA" };

export const ICAL_LABEL_MAX = 40;

/** What staff see for a feed: the OTA's name, or the name staff gave the OTHER one. */
export function icalChannelName(channel: IcalChannel, label: string | null | undefined): string {
  return channel === "OTHER" && label ? label : ICAL_CHANNEL_NAMES[channel];
};

/** How often each OTA calendar is read (the cron runs every minute and picks the feeds that are due). */
export const ICAL_IMPORT_EVERY_MINUTES = 15;

export interface IcalFeedDto {
  unitId: string;
  unitCode: string;
  unitType: "HOUSE" | "VIP_TENT";
  names: Partial<Record<LocaleCode, string>>;
  channel: IcalChannel;
  /** OTHER only: the OTA's name as staff typed it (null = not named yet). */
  label: string | null;
  /** Our calendar for the OTA to import — a secret link; null without channels.edit. */
  exportUrl: string | null;
  /** The OTA's calendar link that we import; null = not set (or hidden without channels.edit). */
  importUrl: string | null;
  importSet: boolean;
  lastImportAt: string | null;
  lastImportStatus: "OK" | "ERROR" | null;
  lastImportError: string | null;
  /** Nights held by this OTA calendar right now (today on). */
  importedNights: number;
  lastExportAt: string | null;
}

export interface IcalConflictDto {
  unitId: string;
  unitCode: string;
  channel: IcalChannel;
  label: string | null;
  date: string;
  bookingCode: string | null;
  summary: string | null;
  firstSeenAt: string;
}

/** GET /api/admin/channels */
export interface ChannelsDto {
  ical: { enabled: boolean; feeds: IcalFeedDto[]; conflicts: IcalConflictDto[] };
  /** Channex (phases O2–O4): not available yet. */
  channex: { enabled: boolean; available: boolean };
  updatedAt: string | null;
  /** This user may switch the features on / off (channels.toggle — SUPER_ADMIN). */
  canToggle: boolean;
  canEdit: boolean;
}

/** GET / PUT /api/center/channels — what Center shows and switches. */
export interface CenterChannelsDto {
  ical: { enabled: boolean; feedsWithImport: number; errors: number; conflicts: number; lastImportAt: string | null };
  channex: { enabled: boolean; available: boolean };
  updatedAt: string | null;
}
