import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../api/client.ts";

/** Loads a public, cacheable API resource; reloads when the path (language) changes. */
export function usePublicData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
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
