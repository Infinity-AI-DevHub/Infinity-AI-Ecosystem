/**
 * Typed API layer (blueprint 16).
 *
 * One place owns credentials, CSRF, the standard error envelope and version
 * preconditions, so no feature module reinvents them. Session material lives in
 * HttpOnly cookies - never in localStorage - so this layer only ever echoes the
 * readable CSRF cookie back as a header.
 */

import { isDesktop } from './desktop';
import { accessTokenForRequest, clearGrant, refresh as refreshGrant } from './tokens';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3500';
const BASE = `${API_URL}/api/v1`;

export type FieldError = { field: string; message: string };

/** Mirrors the server's error envelope so every screen can react consistently. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[];
  readonly correlationId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    fields: FieldError[] = [],
    correlationId?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.correlationId = correlationId;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** The caller is not signed in, or the session was revoked mid-session. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Authenticated but not permitted - the UI shows a "no access" state, not a login form. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** The record changed underneath an edit; the screen must reload before retrying. */
  get isConflict(): boolean {
    return this.status === 409 || this.status === 412;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** A dependent provider is degraded; the module can offer a reduced experience. */
  get isServiceUnavailable(): boolean {
    return this.status === 503;
  }

  fieldMessage(field: string): string | undefined {
    return this.fields.find((f) => f.field === field)?.message;
  }
}

/** Raised when the network itself failed, which is distinct from a server error. */
export class NetworkError extends Error {
  constructor(message = 'Cannot reach Infinity Workspace') {
    super(message);
    this.name = 'NetworkError';
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Retry-safe commands carry a key so a timeout retry cannot double-apply. */
  idempotencyKey?: string;
  /** Optimistic concurrency: the version the caller believes it is editing. */
  ifMatch?: number;
  signal?: AbortSignal;
};

/** Listeners notified when the server reports the session is gone. */
const sessionLostHandlers = new Set<() => void>();

export function onSessionLost(handler: () => void): () => void {
  sessionLostHandlers.add(handler);
  return () => sessionLostHandlers.delete(handler);
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;

  /**
   * Two authentication schemes, chosen by host rather than by configuration.
   *
   * The desktop client carries a bearer token and needs no CSRF header: that defence
   * exists because a browser attaches cookies to requests the page never made, which
   * never happens to a header the client sets itself. The web build keeps the cookie and
   * double-submit pair exactly as before.
   */
  if (isDesktop) {
    const token = await accessTokenForRequest(BASE);
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (!['GET', 'HEAD'].includes(method)) {
    const csrf = readCookie('iw_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const send = async (): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method,
      headers,
      // Cookies carry the session on the web; on the desktop there are none to send.
      credentials: isDesktop ? 'omit' : 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

  let response: Response;
  try {
    response = await send();

    /**
     * One retry after a refresh.
     *
     * A token can expire between the check above and the request arriving, and a clock
     * that is slightly out makes that likelier. Retrying once on a 401 covers it; the
     * refresh itself is single-flight, so a screen loading several queries at once
     * performs exactly one rotation rather than racing itself into a revoked chain.
     */
    if (response.status === 401 && isDesktop) {
      const renewed = await refreshGrant(BASE);
      if (renewed) {
        headers.authorization = `Bearer ${renewed.accessToken}`;
        response = await send();
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError();
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    const envelope = (payload as { error?: Record<string, unknown> } | null)?.error;
    const error = new ApiError(
      response.status,
      String(envelope?.code ?? 'error'),
      String(envelope?.message ?? 'Something went wrong'),
      (envelope?.fields as FieldError[]) ?? [],
      envelope?.correlationId as string | undefined,
      Number(response.headers.get('retry-after')) || undefined,
    );
    // A revoked session must drop the user to sign-in immediately, wherever they are.
    if (error.isUnauthenticated) {
      // The grant is gone as well as the session, so a stale token is not presented again
      // on the next screen and does not look like a fresh failure.
      if (isDesktop) clearGrant();
      for (const handler of sessionLostHandlers) handler();
    }
    throw error;
  }

  // Version headers let callers pass ifMatch on the next write.
  const etag = response.headers.get('etag');
  if (etag && payload && typeof payload === 'object') {
    Object.defineProperty(payload, '__version', {
      value: Number(etag.replace(/"/g, '')),
      enumerable: false,
    });
  }
  return payload as T;
}

/**
 * Credentials for a raw upload request.
 *
 * File bytes do not go through `request()` - they are FormData or a stream, not JSON -
 * so each upload site builds its own fetch. That is exactly where the two auth schemes
 * get confused: a hand-written fetch with `credentials: 'include'` and a CSRF cookie is
 * the browser scheme, and it arrives unauthenticated in the desktop client, which has no
 * cookies and signs requests with a bearer token instead.
 *
 * Every upload path uses this so the scheme is decided in one place rather than three.
 */
export async function uploadAuth(): Promise<{
  headers: Record<string, string>;
  credentials: RequestCredentials;
}> {
  if (isDesktop) {
    const token = await accessTokenForRequest(BASE);
    return {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      // No ambient cookies to send, and asking for them would attach nothing.
      credentials: 'omit',
    };
  }
  const csrf = readCookie('iw_csrf');
  return {
    headers: csrf ? { 'x-csrf-token': csrf } : {},
    credentials: 'include',
  };
}

/** A non-JSON response fetched through the same authenticated path as every API call. */
export type Download = { blob: Blob; filename: string };

export async function download(path: string): Promise<Download> {
  const headers: Record<string, string> = {};
  if (isDesktop) {
    const token = await accessTokenForRequest(BASE);
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const send = () => fetch(`${BASE}${path}`, {
    headers,
    credentials: isDesktop ? 'omit' : 'include',
  });

  let response: Response;
  try {
    response = await send();
    if (response.status === 401 && isDesktop) {
      const renewed = await refreshGrant(BASE);
      if (renewed) {
        headers.authorization = `Bearer ${renewed.accessToken}`;
        response = await send();
      }
    }
  } catch {
    throw new NetworkError();
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: Record<string, unknown> } | null;
    const envelope = payload?.error;
    const error = new ApiError(
      response.status,
      String(envelope?.code ?? 'error'),
      String(envelope?.message ?? 'Something went wrong'),
      (envelope?.fields as FieldError[]) ?? [],
      envelope?.correlationId as string | undefined,
      Number(response.headers.get('retry-after')) || undefined,
    );
    if (error.isUnauthenticated) {
      if (isDesktop) clearGrant();
      for (const handler of sessionLostHandlers) handler();
    }
    throw error;
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'download';
  return { blob: await response.blob(), filename };
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options: Omit<RequestOptions, 'method'> = {}) =>
    request<T>(path, { ...options, method: 'DELETE' }),
  download,
};

/** Generates a stable key so a retried submit is recognised as the same command. */
export function idempotencyKey(): string {
  return crypto.randomUUID();
}

// ------------------------------------------------------------------ shared types

export type AccessLevel = 'super_admin' | 'admin' | 'manager' | 'staff' | 'auditor' | 'guest' | 'service';

export type User = {
  id: string;
  email: string;
  displayName: string;
  title: string | null;
  departmentId: string | null;
  managerId: string | null;
  accessLevel: AccessLevel;
  status: 'invited' | 'active' | 'suspended' | 'offboarded';
  timezone: string;
  locale: string;
  avatarColor: string;
  modules: string[];
  version: number;
  activatedAt: string | null;
  createdAt: string;
};

export type Company = {
  id: string;
  name: string;
  legal_name: string | null;
  verified_domains: string[];
};

export type Session = {
  user: User | null;
  company: Company | null;
};

export type Capabilities = {
  accessLevel: AccessLevel;
  capabilities: string[];
  groupIds: string[];
  modules: string[];
};

export type Paged<T> = { items: T[]; nextCursor: string | null; total?: number };

export type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

export type Widget<T> = { state: 'ok'; data: T } | { state: 'unavailable'; reason: string };
