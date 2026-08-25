/**
 * Current-user endpoints. The client fetches capabilities at startup and refreshes them
 * after any change; route guards are usability only, the API stays authoritative.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, paginationSchema } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as identity from '../../domains/identity.js';
import * as notifications from '../../domains/notifications.js';
import * as dashboard from '../../domains/dashboard.js';
import { one } from '../../core/db.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (request) => {
    const actor = requireActor(request);
    const user = await identity.findUserById(actor.userId);
    const company = await one<{ id: string; name: string; verified_domains: string[] }>(
      'SELECT id, name, verified_domains FROM companies WHERE id = $1',
      [actor.companyId],
    );
    return {
      user: user ? identity.publicUser(user) : null,
      company,
      mfaEnabled: actor.mfaEnabled,
      mfaSatisfied: actor.mfaSatisfied,
    };
  });

  app.get('/me/capabilities', async (request) => {
    const actor = requireActor(request);
    return {
      accessLevel: actor.accessLevel,
      capabilities: [...actor.capabilities].sort(),
      groupIds: actor.groupIds,
      modules: (await identity.findUserById(actor.userId))?.modules ?? [],
    };
  });

  app.get('/me/dashboard', async (request) => {
    const actor = requireActor(request);
    return dashboard.build(actor);
  });

  app.get('/me/notifications', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      paginationSchema.extend({ unreadOnly: z.coerce.boolean().optional() }),
      request.query,
    );
    return notifications.list(actor.userId, {
      limit: query.limit,
      cursor: query.cursor,
      unreadOnly: query.unreadOnly,
    });
  });

  app.post('/me/notifications/:id/read', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    await notifications.markRead(actor.userId, id);
    return reply.code(204).send();
  });

  app.post('/me/notifications/read-all', async (request) => {
    const actor = requireActor(request);
    return { updated: await notifications.markAllRead(actor.userId) };
  });

  app.patch('/me', async (request) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        displayName: z.string().min(1).max(120).optional(),
        title: z.string().max(120).nullable().optional(),
        timezone: z.string().max(64).optional(),
        locale: z.string().max(16).optional(),
        phone: z.string().max(40).nullable().optional(),
      }),
      request.body,
    );
    // A person may edit their own profile but never their own access level.
    const updated = await identity.updateUser(actor, actor.userId, input, null, request.requestContext);
    return identity.publicUser(updated);
  });
}
