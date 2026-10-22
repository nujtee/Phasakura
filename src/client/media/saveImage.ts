import { useEffect, useRef } from "react";

/**
 * "Save image" for a picture on the page (a payment QR): on iPhone / iPad the share sheet ("Save Image" puts it
 * in Photos, where banking apps read QR codes from); elsewhere a download. The file is fetched when the picture
 * shows, so the tap itself still counts as the person's action (Safari refuses a share sheet after a slow await).
 */
export function useSaveImage(url: string | null | undefined, fileName: string): () => void {
  const file = useRef<File | null>(null);
  useEffect(() => {
    file.current = null;
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, credentials: "same-origin" })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (blob) file.current = new File([blob], withExtension(fileName, blob.type), { type: blob.type || "image/png" });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [url, fileName]);

  return () => {
    if (!url) return;
    const f = file.current;
    if (f && typeof navigator.canShare === "function" && navigator.canShare({ files: [f] }) && isTouchDevice()) {
      navigator.share({ files: [f] }).catch(() => undefined); // closed by the person: nothing to do
      return;
    }
    const a = document.createElement("a");
    const objectUrl = f ? URL.createObjectURL(f) : null;
    a.href = objectUrl ?? url;
    a.download = f?.name ?? fileName;
    a.rel = "noopener";
    if (!objectUrl) a.target = "_blank"; // not fetched (yet): open the picture, long-press to save
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  };
}

function isTouchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

function withExtension(name: string, type: string): string {
  if (/\.\w{3,4}$/.test(name)) return name;
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : type === "image/avif" ? "avif" : "png";
  return `${name}.${ext}`;
}
