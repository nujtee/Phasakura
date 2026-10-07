import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { ResponsiveImage, type ImageLike } from "./ResponsiveImage.tsx";
import { useContentT } from "./useContentT.ts";

export interface LightboxItem {
  id: string;
  image: ImageLike;
  title: string | null;
  caption: string | null;
}

/**
 * Full-screen photo viewer (spec §10): native modal <dialog> (focus stays inside, Esc closes),
 * previous / next buttons, arrow / Home / End keys, swipe, caption and position.
 */
export function Lightbox({ items, index, onIndex, onClose }: {
  items: LightboxItem[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const ct = useContentT();
  const ref = useRef<HTMLDialogElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const open = index !== null && items.length > 0;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    document.documentElement.classList.toggle("has-lightbox", open);
    return () => document.documentElement.classList.remove("has-lightbox");
  }, [open]);

  if (!open) return <dialog ref={ref} className="lightbox" aria-label={ct.lightbox.label} />;
  const i = index!;
  const item = items[i]!;
  const go = (n: number) => onIndex(((n % items.length) + items.length) % items.length);
  const onKey = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(items.length - 1); }
  };
  const onDown = (e: PointerEvent<HTMLElement>) => { start.current = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - s.y)) go(i + (dx < 0 ? 1 : -1));
  };
  const label = item.title ?? item.image.alt;

  return (
    <dialog ref={ref} className="lightbox" aria-label={ct.lightbox.label} onKeyDown={onKey}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lightbox__bar">
        <p className="lightbox__count" aria-live="polite">{fill(ct.lightbox.position, { n: i + 1, total: items.length })}</p>
        <button type="button" className="lightbox__btn lightbox__close" onClick={onClose} aria-label={ct.lightbox.close}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>
      <figure className="lightbox__figure" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { start.current = null; }}>
        <ResponsiveImage key={item.id} image={item.image} sizes={IMAGE_SIZES.lightbox} priority className="lightbox__img" />
        {(item.title || item.caption) && (
          <figcaption className="lightbox__caption">
            {item.title && <strong>{item.title}</strong>}
            {item.caption && <span>{item.caption}</span>}
          </figcaption>
        )}
      </figure>
      {items.length > 1 && (
        <>
          <button type="button" className="lightbox__btn lightbox__nav lightbox__nav--prev" onClick={() => go(i - 1)} aria-label={ct.lightbox.prev}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" className="lightbox__btn lightbox__nav lightbox__nav--next" onClick={() => go(i + 1)} aria-label={ct.lightbox.next}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </>
      )}
      <span className="visually-hidden" aria-live="polite">{label}</span>
    </dialog>
  );
}
