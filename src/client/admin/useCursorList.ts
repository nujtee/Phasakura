import { useCallback, useEffect, useState } from "react";
import type { PageDto } from "../../shared/auth-types.ts";
import { apiGet } from "../api/client.ts";
import { useAdmin } from "./AdminContext.tsx";
import { errorMessage } from "./ui.tsx";

/** Cursor-paginated loader for newest-first log endpoints (security events, audit logs). */
export function useCursorList<T>(buildUrl: (before: string | null) => string) {
  const { t } = useAdmin();
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before: string | null, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await apiGet<PageDto<T>>(buildUrl(before));
      setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setLoading(false);
    }
  }, [buildUrl, t]);

  useEffect(() => {
    void load(null, true);
  }, [load]);

  /** Change loaded rows in place (e.g. after an action on one row) without reloading the list. */
  const update = useCallback((change: (rows: T[]) => T[]) => setItems(change), []);

  return { items, cursor, loading, error, more: () => void load(cursor, false), update };
}
