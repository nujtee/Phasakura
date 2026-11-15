import { useCallback, useEffect, useRef, useState } from "react";
import { bootData } from "../api/boot.ts";
import { apiGet } from "../api/client.ts";

/** Loads a public, cacheable API resource; reloads when the path (language) changes. */
export function usePublicData<T>(path: string | null) {
  // Data that came inside the HTML is there on the very first render: no loading state, no request.
  const inline = useRef<string | null>(null);
  const [data, setData] = useState<T | null>(() => {
    const boot = path ? bootData<T>(path) : null;
    if (boot !== null) inline.current = path;
    return boot;
  });
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    if (inline.current === path && attempt === 0) return;
    inline.current = null;
    const controller = new AbortController();
    setError(false);
    apiGet<T>(path, controller.signal)
      .then(setData)
      .catch(() => !controller.signal.aborted && setError(true));
    return () => controller.abort();
  }, [path, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, error, retry, loading: !!path && !data && !error };
}
