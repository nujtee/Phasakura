import type { ApiErrorBody, ApiSuccess } from "../../shared/api-types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Hook for the admin app: called on 401 so it can return to the login page. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

/**
 * Same-origin JSON request. Cookies are sent only to our own origin, and every
 * state-changing request carries the CSRF header the Worker requires.
 */
export async function apiRequest<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("apiRequest only accepts same-origin /api/ paths");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Requested-With"] = "phasakura";
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, "NETWORK", "Network error");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const err = (payload as ApiErrorBody | null)?.error;
    if (response.status === 401 && path !== "/api/auth/login") onUnauthorized?.();
    throw new ApiError(response.status, err?.code ?? "UNKNOWN", err?.message ?? response.statusText, err?.details ?? {});
  }
  return (payload as ApiSuccess<T>).data;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>("GET", path, undefined, signal);
}

/** Multipart upload (same-origin, CSRF header). */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("apiUpload only accepts same-origin /api/ paths");
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers: { "X-Requested-With": "phasakura", Accept: "application/json" }, credentials: "same-origin", body: form });
  } catch {
    throw new ApiError(0, "NETWORK", "Network error");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const err = (payload as ApiErrorBody | null)?.error;
    if (response.status === 401) onUnauthorized?.();
    throw new ApiError(response.status, err?.code ?? "UNKNOWN", err?.message ?? response.statusText, err?.details ?? {});
  }
  return (payload as ApiSuccess<T>).data;
}
