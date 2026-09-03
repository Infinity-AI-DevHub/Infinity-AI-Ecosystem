/**
 * Current-user endpoints. The client fetches capabilities at startup and refreshes them
 * after any change; route guards are usability only, the API stays authoritative.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, paginationSchema } from '../../core/validation.js';
import { csrfTokenFor, requireActor } from '../context.js';
import * as identity from '../../domains/identity.js';
import * as notifications from '../../domains/notifications.js';
import * as dashboard from '../../domains/dashboard.js';
import { one } from '../../core/db.js';
import * as activity from '../../domains/activity.js';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/activity', async (request) => {
    const actor = requireActor(request);
    return activity.counts(actor);
  });


  app.get('/me', async (request) => {
    const actor = requireActor(request);
    const user = await identity.findUserById(actor.userId);
    const company = await one<{
      id: string;
      name: string;
      legal_name: string | null;
      verified_domains: unknown;
    }>('SELECT id, name, legal_name, verified_domains FROM companies WHERE id = $1', [
      actor.companyId,
    ]);
    /*
     * The CSRF token, for a client that cannot read the cookie carrying it.
     *
     * The double-submit pair assumes the page and the API share a cookie scope. They do
     * not when the two are on different hosts — the client portal is served from one
     * host and the API from another, so `document.cookie` on the portal never contains
     * the token, every write was sent without the header, and the API correctly refused
     * it. Returning it here removes the dependency on cookie scope entirely.
     *
     * Safe to return: reading it requires a credentialed same-site request that CORS
     * already restricts to known origins, which is exactly the protection the readable
     * cookie relied on. This is the standard token-endpoint pattern.
     */
    return {
      user: user ? identity.publicUser(user) : null,
      company,
      csrfToken: await csrfTokenFor(request),
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

  /**
   * Clearing, which is a different act from reading.
   *
   * Reading says "I have seen this"; clearing says "I am done with it". The panel only
   * had the first, so it filled up with things people had already dealt with and stayed
   * that way until retention caught up weeks later.
   */
  app.delete('/me/notifications/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    await notifications.dismiss(actor.userId, id);
    return reply.code(204).send();
  });

  app.delete('/me/notifications', async (request) => {
    const actor = requireActor(request);
    return { cleared: await notifications.dismissAll(actor.userId) };
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
