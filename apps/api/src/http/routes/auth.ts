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
