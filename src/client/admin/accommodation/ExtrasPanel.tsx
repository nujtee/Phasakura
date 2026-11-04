import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { useAdmin } from "../AdminContext.tsx";
import { ExtraBedsCard } from "./ExtraBedsCard.tsx";
import { MassageCard } from "./MassageCard.tsx";
import { MoveSettingsCard } from "./MoveSettingsCard.tsx";
import { PetsCard } from "./PetsCard.tsx";

/** What an option tells the panel about itself: on / off and what it is set to (null while loading or not readable). */
export interface ExtrasStatus { on: boolean; summary: string }
export interface ExtrasEmbed { onStatus: (status: ExtrasStatus | null) => void }

type Key = "beds" | "pets" | "massage" | "move";

/**
 * The booking add-ons (extra beds, pets, health massage, guests changing their dates) in ONE folded bar above the
 * houses / VIP tents: the bar shows what is on at a glance; opened, one tab per option holds its settings form.
 * Every option stays mounted (hidden when folded or on another tab) so the bar always knows its state.
 */
export function ExtrasPanel() {
  const { t, can } = useAdmin();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Key>("beds");
  const [status, setStatus] = useState<Partial<Record<Key, ExtrasStatus | null>>>({});

  const tabs = useMemo(() => {
    const all: { key: Key; title: string; short: string }[] = [
      { key: "beds", title: t.acc.extraBedsTitle, short: t.acc.extrasBeds },
      { key: "pets", title: t.acc.petsTitle, short: t.acc.extrasPets },
      { key: "massage", title: t.acc.massageTitle, short: t.acc.extrasMassage },
      { key: "move", title: t.acc.moveTitle, short: t.acc.extrasMove },
    ];
    // Changing dates is booking policy: only people who may read bookings see it (as before).
    return all.filter((x) => x.key !== "move" || can("bookings.view"));
  }, [t, can]);

  // Stable per option, so the forms report without re-rendering in a loop.
  const embeds = useMemo(() => Object.fromEntries((["beds", "pets", "massage", "move"] as Key[]).map((k) => [k, {
    onStatus: (s: ExtrasStatus | null) => setStatus((cur) => (cur[k]?.on === s?.on && cur[k]?.summary === s?.summary ? cur : { ...cur, [k]: s })),
  } satisfies ExtrasEmbed])) as Record<Key, ExtrasEmbed>, []);

  const known = tabs.filter((x) => status[x.key]);
  const onCount = known.filter((x) => status[x.key]!.on).length;
  const current = tabs.find((x) => x.key === tab) ?? tabs[0]!;
  const cur = status[current.key];

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + step + tabs.length) % tabs.length;
    setTab(tabs[next]!.key);
    document.getElementById(`${id}-tab-${tabs[next]!.key}`)?.focus();
  };

  return (
    <section className="adm-card adm-extras" aria-labelledby={`${id}-title`}>
      <button type="button" className="adm-extras__bar" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen((v) => !v)}>
        <span className="adm-extras__head">
          <span className="adm-extras__titleline">
            <span className="adm-extras__title" id={`${id}-title`}>{t.acc.extrasTitle}</span>
            {known.length > 0 && <span className="adm-small adm-muted">{format(t.acc.extrasCount, { on: onCount, total: tabs.length })}</span>}
          </span>
          <span className="adm-extras__chips">
            {tabs.map((x) => {
              const s = status[x.key];
              return (
                <span key={x.key} className={`adm-extras__chip${s?.on ? " is-on" : ""}`} title={s?.summary}>
                  <i aria-hidden="true" />{x.short}
                  <span className="visually-hidden"> · {s ? (s.on ? t.acc.extraBedsBadgeOn : t.acc.extraBedsBadgeOff) : ""}</span>
                </span>
              );
            })}
          </span>
        </span>
        <span className="adm-extras__toggle">
          {open ? t.acc.extrasClose : t.acc.extrasOpen}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            className={open ? "is-open" : undefined}><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </button>

      <div id={`${id}-body`} className="adm-extras__body" hidden={!open}>
        <div className="adm-extras__tabs" role="tablist" aria-label={t.acc.extrasTitle}>
          {tabs.map((x, i) => (
            <button key={x.key} id={`${id}-tab-${x.key}`} type="button" role="tab" aria-selected={x.key === current.key}
              aria-controls={`${id}-panel-${x.key}`} tabIndex={x.key === current.key ? 0 : -1}
              className={`adm-extras__tab${x.key === current.key ? " is-selected" : ""}${status[x.key]?.on ? " is-on" : ""}`}
              onClick={() => setTab(x.key)} onKeyDown={(e) => onTabKey(e, i)}>
              <i aria-hidden="true" />{x.title}
            </button>
          ))}
        </div>
        {cur && (
          <p className="adm-extras__summary">
            <span className={`adm-badge ${cur.on ? "adm-badge--active" : "adm-badge--deleted"}`}>{cur.on ? t.acc.extraBedsBadgeOn : t.acc.extraBedsBadgeOff}</span>{" "}
            {cur.summary}
          </p>
        )}
        {tabs.map((x) => (
          <div key={x.key} id={`${id}-panel-${x.key}`} role="tabpanel" aria-labelledby={`${id}-tab-${x.key}`} hidden={x.key !== current.key}>
            {x.key === "beds" && <ExtraBedsCard embedded={embeds.beds} />}
            {x.key === "pets" && <PetsCard embedded={embeds.pets} />}
            {x.key === "massage" && <MassageCard embedded={embeds.massage} />}
            {x.key === "move" && <MoveSettingsCard embedded={embeds.move} />}
          </div>
        ))}
      </div>
    </section>
  );
}
