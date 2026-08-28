/**
 * HTTP server assembly: security headers, CORS, cookies, rate limits, correlation IDs,
 * the standard error envelope, and route registration.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { AppError, forbidden, internal } from '../core/errors.js';
import { enforce } from '../core/ratelimit.js';
import { assertCsrf, clientIp, correlationIdOf, resolveActor } from './context.js';
import { guestMayReach } from './guest-surface.js';
import { registerRoutes } from './routes/index.js';
import { registerWebsocket } from './websocket.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    // Fastify 5 takes a pre-built logger via loggerInstance; `logger` is config-only.
    // pino's concrete Logger and FastifyBaseLogger are structurally compatible at
    // runtime; the assertion keeps the app on Fastify's default generics.
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    // The API serves JSON and signed object streams, never HTML application content.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and server-to-server calls carry no Origin header.
      if (!origin) return callback(null, true);
      const allowed = [config.publicUrl, config.apiUrl].filter(Boolean);
      callback(null, allowed.includes(origin));
    },
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-api-token', 'idempotency-key', 'if-match', 'x-correlation-id'],
    exposedHeaders: ['etag', 'x-correlation-id', 'retry-after', 'idempotent-replay'],
    maxAge: 600,
  });

  await app.register(cookie, { secret: config.security.dataKey });
  await app.register(multipart, {
    limits: { fileSize: config.limits.uploadMaxBytes, files: 1 },
  });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  // ------------------------------------------------------------- hooks

  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = correlationIdOf(request);
    reply.header('x-correlation-id', request.correlationId);
    request.requestContext = {
      ip: clientIp(request),
      userAgent: request.headers['user-agent'] ?? null,
      correlationId: request.correlationId,
    };
  });

  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/v1/ws')) return;

    const actor = await resolveActor(request);
    if (actor) request.actor = actor;

    // Per-identity limit for authenticated traffic, per-IP for anonymous traffic.
    const bucket = actor
      ? `api:user:${actor.userId}`
      : `api:ip:${request.ip}`;
    await enforce(bucket, config.limits.apiPerMinute, 60);

    // Guests are external people. They are denied every route that is not named on the
    // guest surface, so a company-wide listing that scopes by company alone - which is
    // correct for an employee - cannot leak to a client contact who holds a row in the
    // same company. See guest-surface.ts for what is open and why.
    if (actor?.accessLevel === 'guest' && !guestMayReach(request.url)) {
      throw forbidden('This is not available to guest accounts');
    }

    await assertCsrf(request);
  });

  // ------------------------------------------------------------- errors

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId ?? 'unknown';

    if (error instanceof AppError) {
      if (error.statusCode === 429) {
        reply.header('retry-after', String(error.meta.retryAfterSeconds ?? 60));
      }
      if (error.statusCode >= 500) {
        request.log.error({ err: error, correlationId }, 'request failed');
      }
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          fields: error.fields,
          correlationId,
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: 'unprocessable',
          message: 'Request validation failed',
          fields: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
          correlationId,
        },
      });
    }

    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'payload_too_large', message: 'Upload exceeds the allowed size', fields: [], correlationId },
      });
    }

    // Anything unrecognised is logged in full and reported without internal detail.
    request.log.error({ err: error, correlationId }, 'unhandled error');
    const fallback = internal();
    return reply.status(500).send({
      error: { code: fallback.code, message: fallback.message, fields: [], correlationId },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Endpoint not found',
        fields: [],
        correlationId: request.correlationId ?? 'unknown',
      },
    });
  });

  await registerRoutes(app);
  await registerWebsocket(app);

  return app;
}
