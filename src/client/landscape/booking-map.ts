import type { AvailabilityDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import type { LandscapeDocument, LandscapeObject } from "../../shared/landscape-types.ts";
import { worldSize, toWorld, type Size } from "./geometry.ts";

/**
 * The booking-page map (landscape, phase L3): which plan objects a guest can tap, and how each looks.
 *
 * Colours only guide the guest. The server checks every quote and booking again, so a stale map never books a
 * stay that is taken.
 */

export type StayStatus = "available" | "unavailable" | "picked" | "unknown";

export type MapTarget =
  | { kind: "UNIT"; object: LandscapeObject; unit: PublicUnitDto; status: StayStatus }
  | { kind: "CAMPING"; object: LandscapeObject; status: StayStatus };

/** Plans the booking page can draw now. Satellite plans come with phase L4. */
export function drawable(doc: LandscapeDocument): boolean {
  return doc.version === 1 && (doc.background.kind === "BLANK" || doc.background.kind === "PHOTO");
}

/** Objects in world units, bottom → top (layer order, then list order), and the frame they are drawn on. */
export function mapScene(doc: LandscapeDocument, photo: { width: number; height: number } | null): { size: Size; objects: LandscapeObject[] } {
  const size = worldSize(doc, photo);
  const rank = new Map(doc.layers.map((l, i) => [l.id, i]));
  const objects = toWorld(doc, size)
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => rank.has(o.layerId))
    .sort((a, b) => (rank.get(a.o.layerId)! - rank.get(b.o.layerId)!) || a.i - b.i)
    .map(({ o }) => o);
  return { size, objects };
}

export function unitStatus(unit: PublicUnitDto, availability: AvailabilityDto | null, pickedIds: ReadonlySet<string>): StayStatus {
  if (pickedIds.has(unit.id)) return "picked";
  const a = availability?.units.find((u) => u.unitId === unit.id);
  if (!a) return "unknown";
  return a.available ? "available" : "unavailable";
}

export function campingStatus(availability: AvailabilityDto | null, campingEnabled: boolean, picked: boolean): StayStatus {
  if (!campingEnabled) return "unavailable";
  if (picked) return "picked";
  if (!availability) return "unknown";
  return availability.camping.enabled && availability.camping.remaining > 0 ? "available" : "unavailable";
}

/**
 * The objects a guest can tap: linked to a house / VIP tent the booking page shows, or to camping (when it is on).
 * Links to units that are not public (hidden, archived) stay plain drawings.
 */
export function mapTargets(objects: LandscapeObject[], opts: {
  units: PublicUnitDto[];
  availability: AvailabilityDto | null;
  pickedIds: ReadonlySet<string>;
  campingEnabled: boolean;
  campingPicked: boolean;
}): Map<string, MapTarget> {
  const units = new Map(opts.units.map((u) => [u.id, u]));
  const out = new Map<string, MapTarget>();
  for (const o of objects) {
    if (o.link?.type === "UNIT") {
      const unit = units.get(o.link.unitId);
      if (unit) out.set(o.id, { kind: "UNIT", object: o, unit, status: unitStatus(unit, opts.availability, opts.pickedIds) });
    } else if (o.link?.type === "CAMPING" && opts.campingEnabled) {
      out.set(o.id, { kind: "CAMPING", object: o, status: campingStatus(opts.availability, opts.campingEnabled, opts.campingPicked) });
    }
  }
  return out;
}
