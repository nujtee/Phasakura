/**
 * Typed application errors. Controllers/services throw these; the top-level
 * handler converts them to a JSON error response without leaking internals.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
    /** For the owner's error log only (System status), never sent to the client — e.g. a provider's error code. */
    readonly logDetail?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request", code = "BAD_REQUEST") {
    super(400, code, message);
  }
}

/** 422 with per-field error codes, e.g. { email: "INVALID_EMAIL" }. */
export class ValidationError extends HttpError {
  constructor(details: Record<string, string>, message = "Validation failed") {
    super(422, "VALIDATION_FAILED", message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Authentication required", code = "UNAUTHORIZED") {
    super(401, code, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "You do not have permission to perform this action", code = "FORBIDDEN") {
    super(403, code, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found", code = "NOT_FOUND") {
    super(404, code, message);
  }
}

export class MethodNotAllowedError extends HttpError {
  constructor(readonly allow: string[]) {
    super(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, code = "CONFLICT") {
    super(409, code, message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor() {
    super(413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor() {
    super(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(readonly retryAfterSeconds: number, message = "Too many requests. Please try again later.") {
    super(429, "TOO_MANY_REQUESTS", message);
  }
}
