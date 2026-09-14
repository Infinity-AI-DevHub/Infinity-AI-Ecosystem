/**
 * Access governance routes: the systems catalogue, requests, grants, reviews and the
 * follow-up work of offboarding.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as access from '../../domains/access.js';

const idParam = z.object({ id: z.string().uuid() });
const dateTime = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}.*)?$/));
const grantStatus = z.enum(['pending_grant', 'active', 'pending_removal', 'removed']);

const resourceBody = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().max(1000).nullable().optional(),
  kind: z.enum(['application', 'infrastructure', 'data', 'physical', 'other']),
  roles: z.array(z.string().max(60)).min(1).max(20),
  risk: z.enum(['low', 'medium', 'high']),
  ownerId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  maxDays: z.number().int().min(1).max(365).nullable().optional(),
  requiredCourseId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function accessRoutes(app: FastifyInstance): Promise<void> {
  app.get('/access/summary', async (request) => (await access.myAccessSummary(requireActor(request))) ?? {});

  app.get('/access/resources', async (request) => {
    const q = parse(z.object({ includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }), request.query);
    return { items: await access.listResources(requireActor(request), q) };
  });
  app.post('/access/resources', async (request, reply) => {
    reply.code(201);
    return access.saveResource(requireActor(request), null, parse(resourceBody, request.body));
  });
  app.put('/access/resources/:id', async (request) => access.saveResource(requireActor(request), parse(idParam, request.params).id, parse(resourceBody, request.body)));

  app.get('/access/requests', async (request) => {
    const q = parse(z.object({ scope: z.enum(['mine', 'all']).default('mine'), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), request.query);
    return { items: await access.listRequests(requireActor(request), q) };
  });
  app.post('/access/requests', async (request, reply) => {
    const input = parse(z.object({ resourceId: z.string().uuid(), role: z.string().min(1).max(60), userId: z.string().uuid().nullable().optional(), justification: z.string().trim().min(10).max(1000), durationDays: z.number().int().min(1).max(365).nullable().optional() }), request.body);
    reply.code(201);
    return access.requestAccess(requireActor(request), input, request.requestContext.correlationId);
  });
  app.post('/access/requests/:id/cancel', async (request, reply) => {
    await access.cancelRequest(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  app.get('/access/grants', async (request) => {
    const q = parse(z.object({ view: z.enum(['mine', 'todo', 'all']).default('mine'), resourceId: z.string().uuid().optional(), userId: z.string().uuid().optional(), status: grantStatus.optional(), limit: z.coerce.number().int().min(1).max(100).default(100) }), request.query);
    return { items: await access.listGrants(requireActor(request), q) };
  });
  app.post('/access/grants', async (request, reply) => {
    const input = parse(z.object({ resourceId: z.string().uuid(), role: z.string().min(1).max(60), userId: z.string().uuid(), expiresAt: dateTime.nullable().optional(), note: z.string().max(500).nullable().optional() }), request.body);
    reply.code(201);
    return access.recordExistingGrant(requireActor(request), input);
  });
  app.post('/access/grants/:id/confirm', async (request, reply) => {
    await access.confirmGrant(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.post('/access/grants/:id/revoke', async (request, reply) => {
    const { note } = parse(z.object({ note: z.string().trim().min(3).max(500) }), request.body);
    await access.revokeGrant(requireActor(request), parse(idParam, request.params).id, note);
    reply.code(204);
  });
  app.post('/access/grants/:id/removed', async (request, reply) => {
    await access.confirmRemoval(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  app.get('/access/reviews', async (request) => ({ items: await access.listReviews(requireActor(request)) }));
  app.post('/access/reviews', async (request, reply) => {
    const input = parse(z.object({ name: z.string().trim().min(3).max(160), resourceId: z.string().uuid().nullable().optional(), dueAt: dateTime }), request.body);
    reply.code(201);
    return access.createReview(requireActor(request), input);
  });
  app.get('/access/reviews/:id', async (request) => access.getReview(requireActor(request), parse(idParam, request.params).id));
  app.post('/access/reviews/:id/close', async (request, reply) => {
    await access.closeReview(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.post('/access/review-items/:id', async (request, reply) => {
    const input = parse(z.object({ decision: z.enum(['keep', 'revoke']), note: z.string().max(500).nullable().optional() }), request.body);
    await access.decideReviewItem(requireActor(request), parse(idParam, request.params).id, input);
    reply.code(204);
  });

  app.delete('/access/resources/:id', async (request, reply) => {
    await access.deleteResource(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/access/reviews/:id', async (request, reply) => {
    await access.deleteReview(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/access/offboarding-tasks/:id', async (request, reply) => {
    await access.deleteOffboardingTask(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  app.get('/access/offboardings', async (request) => ({ items: await access.listOffboardings(requireActor(request)) }));
  app.get('/access/offboarding-tasks', async (request) => {
    const q = parse(z.object({ offboardingId: z.string().uuid().optional(), mine: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }), request.query);
    return { items: await access.listOffboardingTasks(requireActor(request), q) };
  });
  app.post('/access/offboardings/:id/tasks', async (request, reply) => {
    const input = parse(z.object({ title: z.string().trim().min(3).max(300), assigneeId: z.string().uuid().nullable().optional() }), request.body);
    reply.code(201);
    return access.addOffboardingTask(requireActor(request), parse(idParam, request.params).id, input);
  });
  app.post('/access/offboarding-tasks/:id/done', async (request, reply) => {
    await access.completeOffboardingTask(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
}
