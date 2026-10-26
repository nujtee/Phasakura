import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SaveImageLabels {
  /** "Press and hold the picture, then choose “Save Image”". */
  hint: string;
  close: string;
  alt: string;
}

/**
 * "Save image" for a payment QR, on every phone:
 *  - iPhone / iPad (Safari, Chrome): the share sheet — "Save Image" puts it in Photos, where banking apps read QR codes;
 *  - Android and computers: a download (Android: Files → Downloads, shown in Gallery);
 *  - in-app browsers (LINE, Facebook, Instagram…), which ignore downloads and often have no share sheet, or when
 *    anything above fails: the picture full screen with "press and hold → Save Image", which works everywhere.
 * The file is read when the picture shows, so the tap itself still counts as the person's action (Safari refuses a
 * share sheet after a slow await). `source` is a URL on this site, or a function giving the image (a drawn QR).
 */
export function useSaveImage(source: string | (() => Blob | null) | null | undefined, fileName: string, labels: SaveImageLabels): {
  save: () => void;
  sheet: ReactNode;
} {
  const fetched = useRef<File | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const url = typeof source === "string" ? source : null;

  useEffect(() => {
    fetched.current = null;
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, credentials: "same-origin" })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (blob) fetched.current = new File([blob], withExtension(fileName, blob.type), { type: blob.type || "image/png" });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [url, fileName]);

  function fileNow(): File | null {
    if (typeof source === "function") {
      const blob = source();
      return blob ? new File([blob], withExtension(fileName, blob.type), { type: blob.type || "image/png" }) : null;
    }
    return fetched.current;
  }

  // The picture full screen: the site's own image URL (press-and-hold saves it in every browser), else a drawn QR
  // as a data: URL (the page's CSP allows data: images, not blob:).
  function showFull(file: File | null) {
    if (url || !file) return setShown(url);
    const reader = new FileReader();
    reader.onload = () => setShown(typeof reader.result === "string" ? reader.result : url);
    reader.onerror = () => setShown(url);
    reader.readAsDataURL(file);
  }

  function save() {
    const file = fileNow();
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    if (!file || isInApp(ua)) return showFull(file);
    if (isIos(ua)) {
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file] }).catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) showFull(file); // closed by the person: nothing to do
        });
      } else showFull(file);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = file.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }

  const sheet = shown ? (
    <div className="save-image" role="dialog" aria-modal="true" aria-label={labels.hint} onClick={() => setShown(null)}>
      <div className="save-image__box" onClick={(e) => e.stopPropagation()}>
        <img className="save-image__img" src={shown} alt={labels.alt} />
        <p className="save-image__hint">{labels.hint}</p>
        <button type="button" className="save-image__close" onClick={() => setShown(null)} autoFocus>{labels.close}</button>
      </div>
    </div>
  ) : null;
  return { save, sheet };
}

/** Browsers inside apps: downloads go nowhere there. */
export function isInApp(ua: string): boolean {
  return /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|KAKAOTALK|TikTok|musical_ly|; wv\)/i.test(ua);
}

export function isIos(ua: string): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS asks for the desktop site: a "Mac" with a touch screen.
  return /Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1;
}

/** "data:image/png;base64,…" → Blob (the PromptPay QR drawn in the page). */
export function dataUrlToBlob(dataUrl: string | null): Blob | null {
  const m = dataUrl ? /^data:([^;,]+);base64,(.*)$/.exec(dataUrl) : null;
  if (!m) return null;
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

function withExtension(name: string, type: string): string {
  if (/\.\w{3,4}$/.test(name)) return name;
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : type === "image/avif" ? "avif" : "png";
  return `${name}.${ext}`;
}
