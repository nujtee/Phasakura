import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { PublicSlideDto } from "../../shared/content-types.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { useContentT } from "./useContentT.ts";
import { SmartLink } from "./SmartLink.tsx";

export const SLIDE_INTERVAL_MS = 5000;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Home hero slideshow (spec §9): autoplay every 5 s, previous / next, swipe, arrow keys,
 * pause button (and pause while hovered or focused), no autoplay with reduced motion,
 * first image preloaded, the others loaded only when they are about to be shown.
 */
export function HeroSlideshow({ slides, title }: { slides: PublicSlideDto[]; title: string }) {
  const ct = useContentT();
  const id = useId();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(() => slides.length > 1 && !prefersReducedMotion());
  const [hold, setHold] = useState({ hover: false, focus: false });
  const [loaded, setLoaded] = useState(() => new Set([0, 1 % Math.max(1, slides.length)]));
  const start = useRef<{ x: number; y: number } | null>(null);
  const count = slides.length;

  const go = useCallback((next: number) => {
    const i = ((next % count) + count) % count;
    setIndex(i);
    setLoaded((s) => (s.has(i) && s.has((i + 1) % count) ? s : new Set([...s, i, (i + 1) % count])));
  }, [count]);

  // Autoplay: one timer per shown slide; stops while paused, hovered, focused or the tab is hidden.
  useEffect(() => {
    if (!playing || hold.hover || hold.focus || count < 2) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") go(index + 1);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [playing, hold, index, count, go]);

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowRight") { e.preventDefault(); go(index + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(index - 1); }
  };
  const onDown = (e: PointerEvent<HTMLElement>) => { start.current = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - s.y)) go(index + (dx < 0 ? 1 : -1));
  };

  if (!count) return null;
  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label={ct.slideshow.region}
      onKeyDown={onKey}
      onMouseEnter={() => setHold((h) => ({ ...h, hover: true }))}
      onMouseLeave={() => setHold((h) => ({ ...h, hover: false }))}
      onFocus={() => setHold((h) => ({ ...h, focus: true }))}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold((h) => ({ ...h, focus: false })); }}
    >
      <h1 className="visually-hidden">{title}</h1>
      <div className="hero__viewport" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { start.current = null; }}
        aria-live={playing ? "off" : "polite"} id={`${id}-slides`}>
        {slides.map((s, i) => {
          const active = i === index;
          const overlay = s.overlay.enabled
            ? ({ "--hero-overlay": s.overlay.color, "--hero-overlay-opacity": String(s.overlay.opacity / 100) } as CSSProperties)
            : undefined;
          return (
            <div key={s.id} className={`hero__slide${active ? " is-active" : ""}${s.overlay.enabled ? " hero__slide--overlay" : ""}`}
              role="group" aria-roledescription="slide" aria-label={fill(ct.slideshow.position, { n: i + 1, total: count })}
              aria-hidden={active ? undefined : true} style={overlay}>
              {loaded.has(i) && (
                <picture className="hero__media">
                  {s.mobile && <source media="(max-width: 767px)" srcSet={s.mobile.srcset ?? s.mobile.url} sizes={IMAGE_SIZES.hero} />}
                  <img src={s.desktop.url} srcSet={s.desktop.srcset ?? undefined} sizes={s.desktop.srcset ? IMAGE_SIZES.hero : undefined}
                    alt={s.desktop.alt} width={s.desktop.width ?? undefined} height={s.desktop.height ?? undefined}
                    loading={i === 0 ? "eager" : "lazy"} fetchPriority={i === 0 ? "high" : "low"} decoding="async" />
                </picture>
              )}
              {(s.title || s.subtitle || s.description || s.button1 || s.button2) && (
                <div className={`hero__content container hero__content--${s.position.toLowerCase()}`}>
                  <div className="hero__text">
                    {s.subtitle && <p className="hero__subtitle">{s.subtitle}</p>}
                    {s.title && <h2 className="hero__title">{s.title}</h2>}
                    {s.description && <p className="hero__description">{s.description}</p>}
                    {(s.button1 || s.button2) && (
                      <div className="hero__actions">
                        {s.button1 && <SmartLink href={s.button1.url} className="button button--primary hero__button">{s.button1.label}</SmartLink>}
                        {s.button2 && <SmartLink href={s.button2.url} className="button hero__button hero__button--ghost">{s.button2.label}</SmartLink>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {count > 1 && (
        <div className="hero__controls container">
          <div className="hero__dots">
            {slides.map((s, i) => (
              <button key={s.id} type="button" className="hero__dot" aria-label={fill(ct.slideshow.goTo, { n: i + 1 })}
                aria-current={i === index ? "true" : undefined} aria-controls={`${id}-slides`} onClick={() => go(i)}>
                {i === index && playing && !hold.hover && !hold.focus
                  ? <span className="is-running" style={{ animationDuration: `${SLIDE_INTERVAL_MS}ms` }} />
                  : <span />}
              </button>
            ))}
          </div>
          <div className="hero__buttons">
            <button type="button" className="hero__btn" aria-label={playing ? ct.slideshow.pause : ct.slideshow.play} aria-pressed={!playing}
              onClick={() => setPlaying((p) => !p)}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                {playing ? <path d="M8 5v14M16 5v14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  : <path d="M8 5.5v13l11-6.5z" fill="currentColor" />}
              </svg>
            </button>
            <button type="button" className="hero__btn" aria-label={ct.slideshow.prev} aria-controls={`${id}-slides`} onClick={() => go(index - 1)}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" className="hero__btn" aria-label={ct.slideshow.next} aria-controls={`${id}-slides`} onClick={() => go(index + 1)}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
