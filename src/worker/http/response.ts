import type { ApiErrorBody, ApiSuccess } from "../../shared/api-types.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export function jsonOk<T>(data: T, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", JSON_CONTENT_TYPE);
  const body: ApiSuccess<T> = { data };
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extraHeaders: HeadersInit = {},
  details?: Record<string, string>,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", JSON_CONTENT_TYPE);
  headers.set("Cache-Control", "no-store");
  const body: ApiErrorBody = { error: { code, message, requestId, ...(details ? { details } : {}) } };
  return new Response(JSON.stringify(body), { status, headers });
}
