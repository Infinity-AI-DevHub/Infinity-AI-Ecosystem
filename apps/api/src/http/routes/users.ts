/**
 * User administration endpoints (blueprint 03/08).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emailSchema, paginationSchema, parse } from '../../core/validation.js';
import { authorize } from '../../core/authz.js';
import { requireActor, expectedVersion, setVersionHeader, withIdempotency } from '../context.js';
import * as identity from '../../domains/identity.js';
import * as admin from '../../domains/admin.js';
import { notFound } from '../../core/errors.js';

const accessLevels = z.enum(['super_admin', 'admin', 'manager', 'staff', 'auditor', 'guest', 'service']);

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.read', resourceless: true });
    const query = parse(
      paginationSchema.extend({
        status: z.enum(['invited', 'active', 'suspended', 'offboarded']).optional(),
        departmentId: z.string().uuid().optional(),
        q: z.string().max(120).optional(),
        /** The People page asks for these; nothing else should. */
        includeInactive: z.coerce.boolean().optional(),
      }),
      request.query,
    );
    const result = await identity.listUsers(actor, {
      status: query.status,
      departmentId: query.departmentId,
      query: query.q,
      limit: query.limit,
      cursor: query.cursor,
      includeInactive: query.includeInactive,
    });
    return { items: result.items.map(identity.publicUser), nextCursor: result.nextCursor };
  });

  app.get('/users/:id', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.read', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const user = await identity.findUserById(id);
    if (!user || user.company_id !== actor.companyId) throw notFound('Account not found');
    setVersionHeader(reply, user.version);
    return identity.publicUser(user);
  });

  app.post('/users', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.create', resourceless: true });

    return withIdempotency(request, reply, 'POST /users', async () => {
      const input = parse(
        z.object({
          email: emailSchema,
          displayName: z.string().min(1).max(120),
          legalName: z.string().max(160).optional(),
          title: z.string().max(120).optional(),
          accessLevel: accessLevels.default('staff'),
          departmentId: z.string().uuid().nullable().optional(),
          managerId: z.string().uuid().nullable().optional(),
          modules: z.array(z.string().max(40)).max(20).optional(),
          groupIds: z.array(z.string().uuid()).max(50).optional(),
        }),
        request.body,
      );
      const result = await identity.createUser(actor, input, request.requestContext);
      return {
        statusCode: 201,
        body: {
          user: identity.publicUser(result.user),
          // The activation link is returned to the administrator; the worker also emails it.
          invitation: { url: result.invitationUrl, expiresInHours: 72 },
        },
      };
    });
  });

  app.patch('/users/:id', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.update', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(
      z.object({
        displayName: z.string().min(1).max(120).optional(),
        title: z.string().max(120).nullable().optional(),
        departmentId: z.string().uuid().nullable().optional(),
        managerId: z.string().uuid().nullable().optional(),
        accessLevel: accessLevels.optional(),
        modules: z.array(z.string().max(40)).max(20).optional(),
        timezone: z.string().max(64).optional(),
        locale: z.string().max(16).optional(),
      }),
      request.body,
    );
    const updated = await identity.updateUser(
      actor,
      id,
      input,
      expectedVersion(request),
      request.requestContext,
    );
    setVersionHeader(reply, updated.version);
    return identity.publicUser(updated);
  });

  app.post('/users/:id/suspend', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.suspend', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), request.body);
    const updated = await identity.suspendUser(actor, id, input.reason, request.requestContext);
    setVersionHeader(reply, updated.version);
    return identity.publicUser(updated);
  });

  /**
   * Offboarding is not suspension: it is terminal, and it always names where the work
   * went. It is idempotency-keyed because a retried click must not offboard twice and
   * transfer a second time against a successor who has already inherited everything.
   */
  app.post('/users/:id/offboard', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.suspend', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(
      z.object({
        successorId: z.string().uuid().nullable().default(null),
        reason: z.string().min(3).max(500),
        lastDay: z.string().date().nullable().optional(),
      }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /users/:id/offboard', async () => {
      const result = await identity.offboardUser(actor, id, input, request.requestContext);
      return {
        statusCode: 200,
        body: { user: identity.publicUser(result.user), transferred: result.transferred },
      };
    });
  });

  app.get('/users/:id/offboarding', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const record = await identity.getOffboarding(actor, id);
    if (!record) throw notFound('No offboarding record for this account');
    return record;
  });

  app.post('/users/:id/reactivate', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.reactivate', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return identity.publicUser(await identity.reactivateUser(actor, id, request.requestContext));
  });

  app.post('/users/:id/invitation', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.create', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return withIdempotency(request, reply, 'POST /users/:id/invitation', async () => {
      const invitation = await identity.reissueInvitation(actor, id, request.requestContext);
      return {
        statusCode: 200,
        body: { invitation: { url: invitation.url, expiresInHours: 72 } },
      };
    });
  });

  app.get('/departments', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'user.read', resourceless: true });
    return { items: await admin.listDepartments(actor.companyId) };
  });
}
