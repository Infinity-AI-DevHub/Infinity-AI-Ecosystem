/**
 * External collaboration routes.
 *
 * Two audiences in one file. Everything under /external and /share-links is staff-facing
 * and authenticated normally. The /shared/:token pair at the bottom is reached by people
 * with no account at all, so those two are the only routes here that skip authentication
 * - and they are rate limited per IP, because an anonymous endpoint that resolves a
 * secret is exactly what a guessing attack aims at.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor, withIdempotency } from '../context.js';
import { enforce } from '../../core/ratelimit.js';
import { clientIp } from '../context.js';
import * as external from '../../domains/external.js';
import * as files from '../../domains/files.js';

const organizationInput = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(['client', 'vendor', 'partner', 'contractor']).optional(),
  website: z.string().max(300).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  billingEmail: z.string().email().max(320).nullable().optional(),
  contactName: z.string().max(160).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  representative: z.string().max(160).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(30).nullable().optional(),
  country: z.string().max(80).nullable().optional(),
  taxRegistration: z.string().max(60).nullable().optional(),
});

export async function externalRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- organisations

  app.get('/external/organizations', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        status: z.enum(['active', 'archived']).optional(),
        kind: z.enum(['client', 'vendor', 'partner', 'contractor']).optional(),
        q: z.string().max(200).optional(),
      }),
      request.query,
    );
    return { items: await external.listOrganizations(actor, query) };
  });

  app.post('/external/organizations', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(organizationInput, request.body);
    reply.code(201);
    return external.createOrganization(actor, input);
  });

  app.get('/external/organizations/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return external.getOrganization(actor, id);
  });

  app.patch('/external/organizations/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(
      organizationInput.partial().extend({ status: z.enum(['active', 'archived']).optional() }),
      request.body,
    );
    return external.updateOrganization(actor, id, input);
  });

  // ---------------------------------------------------------------- guests

  app.get('/external/guests', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({ organizationId: z.string().uuid().optional() }),
      request.query,
    );
    return { items: await external.listGuests(actor, query.organizationId) };
  });

  app.post('/external/guests', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        organizationId: z.string().uuid(),
        email: z.string().email().max(320),
        displayName: z.string().min(1).max(160),
        roleLabel: z.string().max(120).nullable().optional(),
        accessExpiresAt: z.string().datetime().nullable().optional(),
      }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /external/guests', async () => {
      const result = await external.inviteGuest(actor, input, request.requestContext);
      return { statusCode: 201, body: result };
    });
  });

  app.get('/external/guests/:id/grants', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return { items: await external.listGuestGrants(actor, id) };
  });

  app.post('/external/guests/:id/grants', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(
      z.object({
        resourceType: z.enum(['project', 'folder', 'file', 'chat_room']),
        resourceId: z.string().uuid(),
        capabilities: z.array(z.string().max(60)).min(1).max(20),
        expiresAt: z.string().datetime().nullable().optional(),
      }),
      request.body,
    );
    await external.grantGuestAccess(actor, { guestId: id, ...input });
    return reply.code(204).send();
  });

  app.post('/external/guests/:id/revoke', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), request.body);
    await external.revokeGuest(actor, id, input.reason);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- share links

  app.get('/share-links', async (request) => {
    const actor = requireActor(request);
    const query = parse(z.object({ resourceId: z.string().uuid().optional() }), request.query);
    return { items: await external.listShareLinks(actor, query) };
  });

  app.post('/share-links', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        resourceType: z.enum(['file', 'folder']),
        resourceId: z.string().uuid(),
        expiresInDays: z.number().int().min(1).max(90).optional(),
        password: z.string().min(6).max(200).nullable().optional(),
        recipientEmail: z.string().email().max(320).nullable().optional(),
        allowDownload: z.boolean().optional(),
        maxUses: z.number().int().min(1).max(10000).nullable().optional(),
      }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /share-links', async () => {
      const result = await external.createShareLink(actor, input);
      return { statusCode: 201, body: result };
    });
  });

  app.delete('/share-links/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    await external.revokeShareLink(actor, id);
    return reply.code(204).send();
  });

  app.get('/share-links/:id/accesses', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return { items: await external.shareLinkAccesses(actor, id) };
  });
}

/**
 * The anonymous half. Registered separately so it is obvious at the call site that these
 * two routes are outside the authenticated surface.
 */
export async function publicShareRoutes(app: FastifyInstance): Promise<void> {
  const tokenParam = z.object({ token: z.string().min(10).max(200) });

  /** What is behind this link, without consuming a use. */
  app.get('/shared/:token', async (request) => {
    const { token } = parse(tokenParam, request.params);
    await enforce(`share:ip:${request.ip}`, 60, 600);

    const link = await external.resolveShareLink(token);
    // One shape of answer for every reason a link might not work. Distinguishing expired
    // from revoked from never-existed would confirm a guessed token.
    if (!link) {
      const { notFound } = await import('../../core/errors.js');
      throw notFound('This link is no longer available');
    }

    const stored = await external.shareLinkNeedsPassword(link.id);
    const resource = await external.describeSharedResource(link);
    return {
      resourceType: link.resource_type,
      requiresPassword: stored,
      // MySQL hands BOOLEAN back as 1/0; this is a public response shape, so it is
      // coerced here rather than leaking the storage representation to the recipient.
      allowDownload: Boolean(link.allow_download),
      expiresAt: link.expires_at,
      resource,
    };
  });

  /** Open it: enforces the password, counts the use, and records the access. */
  app.post('/shared/:token/open', async (request) => {
    const { token } = parse(tokenParam, request.params);
    await enforce(`share-open:ip:${request.ip}`, 30, 600);
    const input = parse(
      z.object({ password: z.string().max(200).nullable().optional() }),
      request.body ?? {},
    );

    const link = await external.consumeShareLink(token, {
      password: input.password ?? null,
      ip: clientIp(request),
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 400),
      action: 'open',
    });

    const resource = await external.describeSharedResource(link);
    if (link.resource_type === 'file' && link.allow_download) {
      const download = await files.signedDownloadForShare(link.resource_id);
      return { resource, download };
    }
    return { resource, download: null };
  });
}
