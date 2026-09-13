/**
 * Service desk routes.
 *
 * Every rule about who may see or change a ticket lives in domains/service.ts; these
 * handlers only parse input. Portal routes for clients are registered alongside, under
 * /portal/tickets, and are the only ones reachable by a guest (see guest-surface.ts).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, paginationSchema } from '../../core/validation.js';
import { expectedVersion, requireActor } from '../context.js';
import * as service from '../../domains/service.js';

const idParam = z.object({ id: z.string().uuid() });
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const status = z.enum(['new', 'open', 'pending', 'resolved', 'closed']);
const type = z.enum(['incident', 'request', 'question', 'problem']);
const subject = z.string().trim().min(3, 'Give the request a short subject').max(300);
const description = z.string().trim().min(1, 'Describe what you need').max(20000);
const commentBody = z.object({ body: z.string().trim().min(1).max(20000), visibility: z.enum(['public', 'internal']).optional() });

const listQuery = paginationSchema.extend({
  view: z.enum(['all', 'mine', 'assigned', 'unassigned', 'breached', 'requested']).optional(),
  queueId: z.string().uuid().optional(),
  status: z.union([status, z.literal('active')]).optional(),
  priority: priority.optional(),
  clientOrgId: z.string().uuid().optional(),
  requesterId: z.string().uuid().optional(),
  q: z.string().max(120).optional(),
});

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------- configuration */

  app.get('/service/queues', async (request) => ({ items: await service.listQueues(requireActor(request)) }));

  app.post('/service/queues', async (request, reply) => {
    const input = parse(z.object({
      name: z.string().trim().min(2).max(120),
      description: z.string().max(2000).nullable().optional(),
      audience: z.enum(['internal', 'client']).optional(),
      escalationUserId: z.string().uuid().nullable().optional(),
    }), request.body);
    reply.code(201);
    return service.createQueue(requireActor(request), input);
  });

  app.patch('/service/queues/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({
      name: z.string().trim().min(2).max(120).optional(),
      description: z.string().max(2000).nullable().optional(),
      audience: z.enum(['internal', 'client']).optional(),
      escalationUserId: z.string().uuid().nullable().optional(),
      isActive: z.boolean().optional(),
    }), request.body);
    return service.updateQueue(requireActor(request), id, input);
  });

  app.get('/service/queues/:id/members', async (request) => {
    const { id } = parse(idParam, request.params);
    return { items: await service.listQueueMembers(requireActor(request), id) };
  });

  app.get('/service/queues/:id/assignees', async (request) => {
    const { id } = parse(idParam, request.params);
    return { items: await service.listAssignees(requireActor(request), id) };
  });

  app.put('/service/queues/:id/members', async (request) => {
    const { id } = parse(idParam, request.params);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).max(200) }), request.body);
    return service.setQueueMembers(requireActor(request), id, userIds);
  });

  app.post('/service/queues/:id/categories', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(120) }), request.body);
    reply.code(201);
    return service.createCategory(requireActor(request), id, name);
  });

  app.patch('/service/categories/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ name: z.string().trim().min(2).max(120).optional(), isActive: z.boolean().optional() }), request.body);
    return service.updateCategory(requireActor(request), id, input);
  });

  app.get('/service/sla-policies', async (request) => ({ items: await service.listSlaPolicies(requireActor(request)) }));

  app.get('/service/calendar', async (request) => service.getCalendar(requireActor(request)));

  app.put('/service/calendar', async (request) => {
    const input = parse(z.object({
      timezone: z.string().min(1).max(64),
      days: z.record(z.string().regex(/^[1-7]$/), z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)]).nullable()),
      holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366),
    }), request.body);
    return service.setCalendar(requireActor(request), { timezone: input.timezone, days: Object.fromEntries(Object.entries(input.days).filter(([, v]) => v)) as never, holidays: input.holidays });
  });

  app.patch('/service/tickets/bulk', async (request) => {
    const input = parse(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      status: status.optional(),
      priority: priority.optional(),
      assigneeId: z.string().uuid().nullable().optional(),
      queueId: z.string().uuid().optional(),
    }).refine((v) => v.status !== undefined || v.priority !== undefined || v.assigneeId !== undefined || v.queueId !== undefined, 'Choose a change to apply'), request.body);
    const { ids, ...changes } = input;
    return service.bulkUpdate(requireActor(request), ids, changes);
  });

  app.put('/service/sla-policies/:priority', async (request) => {
    const params = parse(z.object({ priority }), request.params);
    const input = parse(z.object({
      firstResponseMinutes: z.number().int().min(1).max(60 * 24 * 30),
      resolutionMinutes: z.number().int().min(1).max(60 * 24 * 90),
      useBusinessHours: z.boolean().optional(),
    }), request.body);
    return service.setSlaPolicy(requireActor(request), params.priority, input);
  });

  app.get('/service/analytics', async (request) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), request.query);
    return service.analytics(requireActor(request), days);
  });

  /* ---------------------------------------------------------------- tickets */

  app.get('/service/tickets', async (request) => service.listTickets(requireActor(request), parse(listQuery, request.query)));

  app.post('/service/tickets', async (request, reply) => {
    const input = parse(z.object({
      subject, description,
      type: type.optional(),
      priority: priority.optional(),
      queueId: z.string().uuid(),
      categoryId: z.string().uuid().nullable().optional(),
      requesterId: z.string().uuid().nullable().optional(),
      clientOrgId: z.string().uuid().nullable().optional(),
      formAnswers: z.record(z.string(), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])).optional(),
    }), request.body);
    reply.code(201);
    return service.createTicket(requireActor(request), input);
  });

  app.get('/service/tickets/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return service.getTicket(requireActor(request), id);
  });

  app.patch('/service/tickets/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({
      subject: subject.optional(),
      status: status.optional(),
      priority: priority.optional(),
      type: type.optional(),
      queueId: z.string().uuid().optional(),
      categoryId: z.string().uuid().nullable().optional(),
      assigneeId: z.string().uuid().nullable().optional(),
      clientOrgId: z.string().uuid().nullable().optional(),
    }), request.body);
    return service.updateTicket(requireActor(request), id, input, expectedVersion(request) ?? undefined);
  });

  app.post('/service/tickets/:id/comments', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    reply.code(201);
    return service.addComment(requireActor(request), id, parse(commentBody, request.body));
  });

  app.post('/service/tickets/:id/attachments', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ fileId: z.string().uuid(), visibility: z.enum(['public', 'internal']).optional() }), request.body);
    reply.code(201);
    return service.attachFile(requireActor(request), id, input);
  });

  app.get('/service/tickets/:id/attachments/:fileId/download', async (request) => {
    const { id, fileId } = parse(z.object({ id: z.string().uuid(), fileId: z.string().uuid() }), request.params);
    return service.attachmentDownload(requireActor(request), id, fileId);
  });

  app.post('/service/tickets/:id/task', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ projectId: z.string().uuid() }), request.body);
    reply.code(201);
    return service.linkTask(requireActor(request), id, input, request.correlationId);
  });

  app.post('/service/tickets/:id/feedback', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).nullable().optional() }), request.body);
    reply.code(201);
    return service.submitFeedback(requireActor(request), id, input);
  });

  /* ----------------------------------------------------------------- portal */

  app.get('/portal/tickets', async (request) => {
    const query = parse(paginationSchema.extend({ status: z.union([status, z.literal('active')]).optional() }), request.query);
    return service.listTickets(requireActor(request), { limit: query.limit, cursor: query.cursor, status: query.status });
  });

  app.post('/portal/tickets', async (request, reply) => {
    const input = parse(z.object({ subject, description, priority: z.enum(['low', 'normal', 'high']).optional() }), request.body);
    reply.code(201);
    return service.createPortalTicket(requireActor(request), input);
  });

  app.get('/portal/tickets/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return service.getTicket(requireActor(request), id);
  });

  app.post('/portal/tickets/:id/comments', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(20000) }), request.body);
    reply.code(201);
    return service.addComment(requireActor(request), id, { body, visibility: 'public' });
  });

  app.post('/portal/tickets/:id/status', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ status: z.enum(['open', 'closed']) }), request.body);
    return service.updateTicket(requireActor(request), id, { status: input.status });
  });

  app.post('/portal/tickets/:id/attachments', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { fileId } = parse(z.object({ fileId: z.string().uuid() }), request.body);
    reply.code(201);
    return service.attachFile(requireActor(request), id, { fileId, visibility: 'public' });
  });

  app.get('/portal/tickets/:id/attachments/:fileId/download', async (request) => {
    const { id, fileId } = parse(z.object({ id: z.string().uuid(), fileId: z.string().uuid() }), request.params);
    return service.attachmentDownload(requireActor(request), id, fileId);
  });

  app.post('/portal/tickets/:id/feedback', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).nullable().optional() }), request.body);
    reply.code(201);
    return service.submitFeedback(requireActor(request), id, input);
  });
}
