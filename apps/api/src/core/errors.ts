/**
 * Standard error envelope (blueprint 08): code, human-safe message, field errors,
 * correlationId. Stack traces are never exposed to clients.
 */
export type FieldError = { field: string; message: string };

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields: FieldError[];
  readonly expose: boolean;
  readonly meta: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { fields?: FieldError[]; meta?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = options.fields ?? [];
    this.meta = options.meta ?? {};
    this.expose = statusCode < 500;
  }
}

export const badRequest = (message: string, fields?: FieldError[]) =>
  new AppError(400, 'bad_request', message, { fields });

/** 401: caller is not authenticated. */
export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, 'unauthenticated', message);

/** 403: caller is authenticated but not permitted. Never leaks resource existence detail. */
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'forbidden', message);

export const notFound = (message = 'Resource not found') =>
  new AppError(404, 'not_found', message);

export const conflict = (message: string, meta?: Record<string, unknown>) =>
  new AppError(409, 'conflict', message, { meta });

/** 412: ETag / version precondition failed on a concurrent update. */
export const preconditionFailed = (message = 'Resource changed since it was read') =>
  new AppError(412, 'precondition_failed', message);

export const payloadTooLarge = (message = 'Payload exceeds the allowed size') =>
  new AppError(413, 'payload_too_large', message);

export const unprocessable = (message: string, fields?: FieldError[]) =>
  new AppError(422, 'unprocessable', message, { fields });

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(429, 'rate_limited', 'Too many requests. Please retry shortly.', {
    meta: { retryAfterSeconds },
  });

export const serviceUnavailable = (message = 'A dependent service is unavailable') =>
  new AppError(503, 'service_unavailable', message);

export const internal = (message = 'Unexpected error') =>
  new AppError(500, 'internal_error', message);
