/**
 * Per-request context: correlation ID, actor resolution, CSRF, idempotency helpers.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthenticated, forbidden, badRequest, AppError } from '../core/errors.js';
import { config } from '../core/config.js';
import { hashToken, safeEqual } from '../core/crypto.js';
import { one, pool } from '../core/db.js';
import * as identity from '../domains/identity.js';
import type { Actor } from '../core/authz.js';
import * as idempotency from '../core/idempotency.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    correlationId: string;
    requestContext: identity.RequestContext;
  }
}

export function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && /^[\w.-]{8,64}$/.test(value) ? value : randomUUID();
}

export function clientIp(request: FastifyRequest): string | null {
  return request.ip ?? null;
}

/** Resolves the caller from a session cookie or a service API token. */
export async function resolveActor(request: FastifyRequest): Promise<Actor | null> {
  const apiToken = request.headers['x-api-token'];
  if (typeof apiToken === 'string' && apiToken.length > 0) {
    const record = await one<{
      id: string;
      user_id: string;
      capabilities: string[];
    }>(
      `SELECT id, user_id, capabilities FROM api_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW(3))`,
      [hashToken(apiToken)],
    );
    if (!record) return null;
    const user = await identity.findUserById(record.user_id);
    if (!user || user.status !== 'active') return null;
    pool
      .query('UPDATE api_tokens SET last_used_at = NOW(3) WHERE id = $1', [record.id])
      .catch(() => undefined);
    // A service token carries no interactive session; its reach is bounded by the
    // capability scope recorded on the token itself.
    return identity.buildActor(user, null, record.capabilities, record.id);
  }

  const cookie = request.cookies[config.security.sessionCookie];
  if (!cookie) return null;
  const resolved = await identity.resolveSession(cookie);
  if (!resolved) return null;
  return identity.buildActor(resolved.user, resolved.session);
}

export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) throw unauthenticated();
  return request.actor;
}

function sameOriginAllowed(request: FastifyRequest): boolean {
  const allowed = new Set([config.publicUrl, config.apiUrl]);
  const originHeader = request.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (origin) return allowed.has(origin);

  const refererHeader = request.headers.referer;
  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
  if (!referer) return !config.isProd;
  try {
    return allowed.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

/**
 * Double-submit CSRF protection for cookie-authenticated state changes.
 * Token-authenticated (service) calls do not use cookies and are exempt.
 */
export async function assertCsrf(request: FastifyRequest): Promise<void> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (typeof request.headers['x-api-token'] === 'string') return;

  const sessionCookie = request.cookies[config.security.sessionCookie];
  if (!sessionCookie) return; // unauthenticated endpoints handle their own protection

  const session = await one<{ csrf_secret: string }>(
    'SELECT csrf_secret FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(sessionCookie)],
  );
  // A cookie that no longer matches a live session protects nothing, so the request is
  // treated as unauthenticated. Without this a stale cookie would block the very
  // endpoints someone needs when their session has gone - signing in, or activating an
  // account - with a misleading CSRF error.
  if (!session) return;

  if (!sameOriginAllowed(request)) throw forbidden('Request origin is not allowed');

  const header = request.headers['x-csrf-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) throw forbidden('Missing CSRF token');

  if (!safeEqual(session.csrf_secret, provided)) {
    throw forbidden('CSRF validation failed');
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, csrfToken: string): void {
  reply.setCookie(config.security.sessionCookie, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    domain: config.security.cookieDomain,
    maxAge: config.security.sessionTtlMinutes * 60,
  });
  // Readable by the SPA so it can echo the value back in the X-CSRF-Token header.
  reply.setCookie(config.security.csrfCookie, csrfToken, {
    httpOnly: false,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    domain: config.security.cookieDomain,
    maxAge: config.security.sessionTtlMinutes * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  for (const name of [config.security.sessionCookie, config.security.csrfCookie]) {
    reply.clearCookie(name, { path: '/', domain: config.security.cookieDomain });
  }
}

/**
 * Wraps a retry-sensitive handler with Idempotency-Key semantics.
 * The key is required in production for these endpoints.
 */
export async function withIdempotency<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
  handler: () => Promise<{ statusCode: number; body: T }>,
): Promise<T> {
  const actor = requireActor(request);
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;

  if (!key) {
    if (config.isProd) {
      throw badRequest(`Idempotency-Key header is required for ${endpoint}`);
    }
    const result = await handler();
    reply.code(result.statusCode);
    return result.body;
  }
  if (key.length > 200) throw badRequest('Idempotency-Key is too long');

  const fingerprint = idempotency.fingerprint(request.body);
  const stored = await idempotency.lookup(key, actor.companyId, actor.userId, endpoint, fingerprint);
  if (stored) {
    reply.code(stored.statusCode).header('idempotent-replay', 'true');
    return stored.body as T;
  }
  try {
    const result = await handler();
    await idempotency.store(key, actor.companyId, endpoint, result.statusCode, result.body);
    reply.code(result.statusCode);
    return result.body;
  } catch (err) {
    // A failed attempt must not permanently block the same key.
    await idempotency.releaseStale(key, actor.companyId, endpoint);
    throw err;
  }
}

/** ETag / If-Match precondition support for concurrent updates. */
export function expectedVersion(request: FastifyRequest): number | null {
  const header = request.headers['if-match'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const parsed = Number(value.replace(/["W/]/g, ''));
  if (!Number.isInteger(parsed)) throw badRequest('If-Match must contain a numeric version');
  return parsed;
}

export function setVersionHeader(reply: FastifyReply, version: number): void {
  reply.header('etag', `"${version}"`);
}

export { AppError };
