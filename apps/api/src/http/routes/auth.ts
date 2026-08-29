/**
 * Authentication endpoints (blueprint 08).
 * Login is rate limited per account and per IP.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, emailSchema } from '../../core/validation.js';
import { enforce } from '../../core/ratelimit.js';
import { config } from '../../core/config.js';
import * as identity from '../../domains/identity.js';
import {
  clearSessionCookie,
  requireActor,
  setSessionCookie,
} from '../context.js';
import { hashToken } from '../../core/crypto.js';
import { pool } from '../../core/db.js';

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(512),
});

const activateSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(1).max(512),
});

const forgotSchema = z.object({ email: z.string().email().max(320) });
const resetSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(1).max(512),
});

const desktopLoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
  /** Shown on the signed-in-devices screen so a person can tell their machines apart. */
  device: z.string().max(160).optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const input = parse(loginSchema, request.body);
    // Two buckets: one slows an attacker hammering a single account, the other slows
    // credential stuffing across many accounts from one source.
    await enforce(`login:email:${hashToken(input.email)}`, config.limits.loginPerMinute, 60);
    await enforce(`login:ip:${request.ip}`, config.limits.loginPerMinute * 3, 60);

    const outcome = await identity.authenticate(input.email, input.password, request.requestContext);
    setSessionCookie(reply, outcome.sessionToken, outcome.csrfToken);
    return reply.code(200).send({
      status: 'authenticated',
      csrfToken: outcome.csrfToken,
      user: identity.publicUser(outcome.user),
    });
  });

  app.post('/auth/activate', async (request, reply) => {
    const input = parse(activateSchema, request.body);
    await enforce(`activate:ip:${request.ip}`, 10, 600);
    const result = await identity.activateAccount(input.token, input.password, request.requestContext);
    return reply.code(201).send({ user: identity.publicUser(result.user) });
  });

  /**
   * Start a reset. The reply is identical whether or not the address has an account:
   * the one thing an anonymous caller must not be able to learn here is who works here.
   * The link itself travels only in the message to the address on file.
   */
  app.post('/auth/password/forgot', async (request, reply) => {
    const input = parse(forgotSchema, request.body);
    // Per-address so one account cannot be mail-bombed, per-IP so one source cannot
    // sweep a list of guessed addresses looking for a difference in timing or effect.
    await enforce(`forgot:email:${hashToken(input.email)}`, 3, 900);
    await enforce(`forgot:ip:${request.ip}`, 15, 900);
    await identity.requestPasswordReset(input.email, request.requestContext);
    return reply.code(202).send({
      status: 'accepted',
      message: 'If that address has an account, a reset link is on its way.',
    });
  });

  app.post('/auth/password/reset', async (request, reply) => {
    const input = parse(resetSchema, request.body);
    await enforce(`reset:ip:${request.ip}`, 10, 600);
    await identity.completePasswordReset(input.token, input.password, request.requestContext);
    // Every session was revoked with the reset, so there is nothing to return but the
    // instruction to sign in again.
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  /**
   * Desktop sign-in. Same credential check as the browser path, different currency: a
   * bearer token pair instead of a cookie, because there is no cookie jar and no
   * cross-site risk for a double-submit token to defend against.
   */
  app.post('/auth/token', async (request, reply) => {
    const input = parse(desktopLoginSchema, request.body);
    await enforce(`login:email:${hashToken(input.email)}`, config.limits.loginPerMinute, 60);
    await enforce(`login:ip:${request.ip}`, config.limits.loginPerMinute * 3, 60);

    const outcome = await identity.authenticate(input.email, input.password, request.requestContext);
    const grant = await identity.issueDesktopSession(
      outcome.user,
      request.requestContext,
      input.device,
    );
    return reply.code(200).send({ ...grant, user: identity.publicUser(outcome.user) });
  });

  /**
   * Rotates the token pair. Rate limited per IP because a stolen refresh token being
   * hammered is exactly what this endpoint would otherwise make cheap.
   */
  app.post('/auth/token/refresh', async (request, reply) => {
    const input = parse(z.object({ refreshToken: z.string().min(10).max(200) }), request.body);
    await enforce(`refresh:ip:${request.ip}`, 60, 600);
    const grant = await identity.refreshDesktopSession(input.refreshToken, request.requestContext);
    return reply.code(200).send(grant);
  });

  app.post('/auth/logout', async (request, reply) => {
    const actor = request.actor;
    if (actor?.sessionId) await identity.revokeSession(actor.sessionId);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post('/auth/password', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }),
      request.body,
    );
    await identity.changeOwnPassword(
      actor.userId,
      input.currentPassword,
      input.newPassword,
      request.requestContext,
    );
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/auth/sessions', async (request) => {
    const actor = requireActor(request);
    return { items: await identity.listSessions(actor.userId) };
  });

  app.delete('/auth/sessions/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    // A person may only revoke their own sessions here; administrators use /users/:id/suspend.
    const owned = await pool.query('SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2', [
      id,
      actor.userId,
    ]);
    if (owned.rowCount === 0) {
      const { notFound } = await import('../../core/errors.js');
      throw notFound('Session not found');
    }
    await identity.revokeSession(id);
    return reply.code(204).send();
  });
}
