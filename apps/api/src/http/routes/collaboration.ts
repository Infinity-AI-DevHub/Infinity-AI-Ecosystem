/**
 * Calendar, chat, tasks, files, approvals, announcements and search endpoints.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, paginationSchema } from '../../core/validation.js';
import { authorize } from '../../core/authz.js';
import { expectedVersion, requireActor, setVersionHeader, withIdempotency } from '../context.js';
import * as calendar from '../../domains/calendar.js';
import * as chat from '../../domains/chat.js';
import * as tasks from '../../domains/tasks.js';
import * as files from '../../domains/files.js';
import * as approvals from '../../domains/approvals.js';
import * as announcements from '../../domains/announcements.js';
import * as search from '../../domains/search.js';

const idParam = z.object({ id: z.string().uuid() });

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  app.get('/calendar/events', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        from: z.string().datetime(),
        to: z.string().datetime(),
        userId: z.string().uuid().optional(),
      }),
      request.query,
    );
    return {
      items: await calendar.listEvents(actor, {
        from: new Date(query.from),
        to: new Date(query.to),
        userId: query.userId,
      }),
    };
  });

  app.post('/calendar/events', async (request, reply) =>
    withIdempotency(request, reply, 'POST /calendar/events', async () => {
      const actor = requireActor(request);
      const input = parse(
        z.object({
          title: z.string().min(1).max(300),
          description: z.string().max(20_000).optional(),
          location: z.string().max(300).optional(),
          onlineUrl: z.string().url().max(600).nullable().optional(),
          roomId: z.string().uuid().nullable().optional(),
          startsAt: z.string().datetime(),
          endsAt: z.string().datetime(),
          timezone: z.string().min(1).max(64),
          allDay: z.boolean().optional(),
          recurrenceRule: z.string().max(300).nullable().optional(),
          visibility: z.enum(['private', 'company']).optional(),
          attendeeIds: z.array(z.string().uuid()).max(500).default([]),
          optionalAttendeeIds: z.array(z.string().uuid()).max(500).optional(),
          agenda: z.string().max(20_000).optional(),
          reminderMinutes: z.number().int().min(0).max(10_080).optional(),
          withVideoRoom: z.boolean().optional(),
        }),
        request.body,
      );
      const event = await calendar.createEvent(actor, input, request.correlationId);
      return { statusCode: 201, body: calendar.publicEvent(event) };
    }),
  );

  app.get('/calendar/events/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const event = await calendar.getEvent(actor, id);
    setVersionHeader(reply, event.version);
    return event;
  });

  app.patch('/calendar/events/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(20_000).optional(),
        location: z.string().max(300).nullable().optional(),
        onlineUrl: z.string().url().max(600).nullable().optional(),
        roomId: z.string().uuid().nullable().optional(),
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().optional(),
        timezone: z.string().max(64).optional(),
        recurrenceRule: z.string().max(300).nullable().optional(),
        agenda: z.string().max(20_000).optional(),
        reminderMinutes: z.number().int().min(0).max(10_080).optional(),
        attendeeIds: z.array(z.string().uuid()).max(500).optional(),
      }),
      request.body,
    );
    const updated = await calendar.updateEvent(actor, id, input, expectedVersion(request), request.correlationId);
    setVersionHeader(reply, updated.version);
    return calendar.publicEvent(updated);
  });

  app.delete('/calendar/events/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await calendar.cancelEvent(actor, id, request.correlationId);
    return reply.code(204).send();
  });

  app.post('/calendar/events/:id/rsvp', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ rsvp: z.enum(['accepted', 'declined', 'tentative']) }), request.body);
    await calendar.respond(actor, id, input.rsvp);
    return reply.code(204).send();
  });

  app.post('/calendar/events/:id/join', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return calendar.joinMeeting(actor, id);
  });

  app.get('/calendar/freebusy', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'freebusy.read', resourceless: true });
    const query = parse(
      z.object({
        userIds: z.string(),
        from: z.string().datetime(),
        to: z.string().datetime(),
      }),
      request.query,
    );
    const ids = query.userIds.split(',').filter((v) => /^[0-9a-f-]{36}$/i.test(v)).slice(0, 50);
    return { busy: await calendar.freeBusy(actor, ids, new Date(query.from), new Date(query.to)) };
  });

  app.get('/calendar/rooms', async (request) => {
    const actor = requireActor(request);
    return { items: await calendar.listRooms(actor.companyId) };
  });
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chat/rooms', async (request) => {
    const actor = requireActor(request);
    return { items: await chat.listRooms(actor) };
  });

  app.post('/chat/rooms', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        name: z.string().min(2).max(60),
        topic: z.string().max(300).optional(),
        visibility: z.enum(['private', 'company']).default('private'),
        memberIds: z.array(z.string().uuid()).max(500).default([]),
      }),
      request.body,
    );
    reply.code(201);
    return chat.createChannel(actor, input);
  });

  app.post('/chat/direct', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(z.object({ userId: z.string().uuid() }), request.body);
    reply.code(201);
    return chat.openDirect(actor, input.userId);
  });

  app.get('/chat/rooms/:id/messages', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const query = parse(
      z.object({
        before: z.coerce.number().int().positive().optional(),
        after: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      request.query,
    );
    return { items: await chat.history(actor, id, query) };
  });

  app.post('/chat/rooms/:id/messages', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        body: z.string().max(8000).default(''),
        parentId: z.string().uuid().nullable().optional(),
        fileId: z.string().uuid().nullable().optional(),
        mentions: z.array(z.string().uuid()).max(50).optional(),
      }),
      request.body,
    );
    reply.code(201);
    return chat.publicMessage(await chat.send(actor, id, input));
  });

  app.patch('/chat/rooms/:id/messages/:messageId', async (request) => {
    const actor = requireActor(request);
    const params = parse(z.object({ id: z.string().uuid(), messageId: z.string().uuid() }), request.params);
    const input = parse(z.object({ body: z.string().min(1).max(8000) }), request.body);
    return chat.publicMessage(await chat.edit(actor, params.id, params.messageId, input.body));
  });

  app.delete('/chat/rooms/:id/messages/:messageId', async (request, reply) => {
    const actor = requireActor(request);
    const params = parse(z.object({ id: z.string().uuid(), messageId: z.string().uuid() }), request.params);
    await chat.remove(actor, params.id, params.messageId);
    return reply.code(204).send();
  });

  app.post('/chat/rooms/:id/read', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ seq: z.number().int().nonnegative() }), request.body);
    await chat.markRead(actor, id, input.seq);
    return reply.code(204).send();
  });

  app.post('/chat/rooms/:id/delivered', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ seq: z.number().int().nonnegative() }), request.body);
    await chat.markDelivered(actor, id, input.seq);
    return reply.code(204).send();
  });

  app.get('/chat/rooms/:id/delivery', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return chat.deliveryState(actor, id);
  });

  app.post('/chat/rooms/:id/members', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ userIds: z.array(z.string().uuid()).min(1).max(200) }), request.body);
    await chat.addMembers(actor, id, input.userIds);
    return reply.code(204).send();
  });

  app.get('/chat/rooms/:id/members', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return { items: await chat.listMembers(actor, id) };
  });

  app.post('/chat/rooms/:id/messages/:messageId/reactions', async (request, reply) => {
    const actor = requireActor(request);
    const params = parse(z.object({ id: z.string().uuid(), messageId: z.string().uuid() }), request.params);
    const input = parse(z.object({ emoji: z.string().min(1).max(16) }), request.body);
    await chat.react(actor, params.id, params.messageId, input.emoji);
    return reply.code(204).send();
  });

  app.post('/chat/rooms/:id/typing', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await chat.typing(actor, id);
    return reply.code(204).send();
  });
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async (request) => {
    const actor = requireActor(request);
    return { items: await tasks.listProjects(actor) };
  });

  app.post('/projects', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        name: z.string().min(1).max(120),
        key: z.string().min(2).max(10),
        description: z.string().max(5000).optional(),
        memberIds: z.array(z.string().uuid()).max(500).optional(),
      }),
      request.body,
    );
    reply.code(201);
    return tasks.createProject(actor, input);
  });

  app.get('/tasks', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        projectId: z.string().uuid().optional(),
        assigneeId: z.string().uuid().optional(),
        status: z.enum(['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      request.query,
    );
    return { items: await tasks.listTasks(actor, query) };
  });

  app.post('/projects/:id/tasks', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(50_000).optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
        dueAt: z.string().datetime().nullable().optional(),
        labels: z.array(z.string().max(40)).max(20).optional(),
        dependsOn: z.array(z.string().uuid()).max(20).optional(),
      }),
      request.body,
    );
    reply.code(201);
    return tasks.publicTask(await tasks.createTask(actor, id, input, request.correlationId));
  });

  app.get('/tasks/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const task = await tasks.getTask(actor, id);
    setVersionHeader(reply, task.version);
    return task;
  });

  app.patch('/tasks/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).optional(),
        status: z.enum(['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled']).optional(),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        dueAt: z.string().datetime().nullable().optional(),
        labels: z.array(z.string().max(40)).max(20).optional(),
        position: z.number().optional(),
      }),
      request.body,
    );
    const updated = await tasks.updateTask(actor, id, input, expectedVersion(request), request.correlationId);
    setVersionHeader(reply, updated.version);
    return tasks.publicTask(updated);
  });

  app.post('/tasks/:id/comments', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ body: z.string().min(1).max(20_000) }), request.body);
    reply.code(201);
    return tasks.comment(actor, id, input.body);
  });
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/files', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        folderId: z.string().uuid().nullable().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        recycled: z.coerce.boolean().optional(),
      }),
      request.query,
    );
    return { items: await files.listFiles(actor, query) };
  });

  app.get('/files/folders', async (request) => {
    const actor = requireActor(request);
    return { items: await files.listFolders(actor) };
  });

  app.post('/files/folders', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({ name: z.string().min(1).max(200), parentId: z.string().uuid().nullable().optional() }),
      request.body,
    );
    reply.code(201);
    return files.createFolder(actor, input.name, input.parentId ?? null);
  });

  app.post('/files/uploads', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        filename: z.string().min(1).max(300),
        mimeType: z.string().min(1).max(200),
        sizeBytes: z.number().int().positive(),
        folderId: z.string().uuid().nullable().optional(),
        fileId: z.string().uuid().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return files.beginUpload(actor, input);
  });

  /** Direct upload path: the API receives the bytes, scans them and stores the object. */
  app.post('/files/uploads/:id/content', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const uploaded = await request.file();
    if (!uploaded) {
      const { badRequest } = await import('../../core/errors.js');
      throw badRequest('No file part was provided');
    }
    const buffer = await uploaded.toBuffer();
    reply.code(201);
    return files.publicFile(await files.receiveUpload(actor, id, buffer));
  });

  app.get('/files/:id/download', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const query = parse(z.object({ version: z.coerce.number().int().positive().optional() }), request.query);
    return files.downloadUrl(actor, id, query.version);
  });

  app.get('/files/:id/versions', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return { items: await files.listVersions(actor, id) };
  });

  app.post('/files/:id/share', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        subjectType: z.enum(['user', 'group']),
        subjectId: z.string().uuid(),
        capabilities: z.array(z.string().max(40)).min(1).max(5),
        expiresAt: z.string().datetime().nullable().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return files.share(actor, id, input);
  });

  app.delete('/files/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await files.recycle(actor, id);
    return reply.code(204).send();
  });

  app.post('/files/:id/restore', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return files.publicFile(await files.restore(actor, id));
  });

  app.post('/files/:id/legal-hold', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ held: z.boolean() }), request.body);
    await files.setLegalHold(actor, id, input.held);
    return reply.code(204).send();
  });
}

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/approvals/definitions', async (request) => {
    const actor = requireActor(request);
    return { items: await approvals.listDefinitions(actor) };
  });

  app.get('/approvals', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        scope: z.enum(['mine', 'pending_me', 'all']).default('pending_me'),
        status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled', 'expired']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    return { items: await approvals.listRequests(actor, query) };
  });

  app.post('/approvals', async (request, reply) =>
    withIdempotency(request, reply, 'POST /approvals', async () => {
      const actor = requireActor(request);
      const input = parse(
        z.object({
          definitionKey: z.string().min(1).max(60),
          title: z.string().min(1).max(300),
          amount: z.number().nonnegative().max(1e12).nullable().optional(),
          currency: z.string().length(3).optional(),
          data: z.record(z.unknown()).optional(),
        }),
        request.body,
      );
      const created = await approvals.createRequest(actor, input, request.correlationId);
      return { statusCode: 201, body: created };
    }),
  );

  app.get('/approvals/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return approvals.getRequest(actor, id);
  });

  app.post('/approvals/:id/decisions', async (request, reply) =>
    withIdempotency(request, reply, 'POST /approvals/:id/decisions', async () => {
      const actor = requireActor(request);
      const { id } = parse(idParam, request.params);
      const input = parse(
        z.object({
          decision: z.enum(['approved', 'rejected', 'returned']),
          comment: z.string().max(5000).optional(),
        }),
        request.body,
      );
      const updated = await approvals.decide(actor, id, input, request.correlationId);
      return { statusCode: 201, body: updated };
    }),
  );

  app.post('/approvals/:id/cancel', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await approvals.cancelRequest(actor, id);
    return reply.code(204).send();
  });
}

export async function announcementRoutes(app: FastifyInstance): Promise<void> {
  app.get('/announcements', async (request) => {
    const actor = requireActor(request);
    return { items: await announcements.listForUser(actor) };
  });

  app.post('/announcements', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        title: z.string().min(1).max(300),
        body: z.string().min(1).max(50_000),
        priority: z.enum(['normal', 'important', 'critical']).optional(),
        audience: z
          .union([
            z.object({ scope: z.literal('company') }),
            z.object({ scope: z.literal('department'), departmentIds: z.array(z.string().uuid()).min(1) }),
            z.object({ scope: z.literal('group'), groupIds: z.array(z.string().uuid()).min(1) }),
          ])
          .optional(),
        requiresAck: z.boolean().optional(),
        publishAt: z.string().datetime().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return announcements.create(actor, input);
  });

  app.get('/announcements/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return announcements.getForUser(actor, id);
  });

  app.post('/announcements/:id/read', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ acknowledge: z.boolean().default(false) }), request.body ?? {});
    await announcements.markRead(actor, id, input.acknowledge);
    return reply.code(204).send();
  });

  app.get('/announcements/:id/stats', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return announcements.stats(actor, id);
  });

  app.delete('/announcements/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await announcements.withdraw(actor, id);
    return reply.code(204).send();
  });
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/search', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'search.query', resourceless: true });
    const query = parse(
      z.object({
        q: z.string().min(1).max(200),
        types: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      request.query,
    );
    const types = query.types
      ?.split(',')
      .filter((t): t is search.DocType =>
        ['mail', 'chat', 'file', 'person', 'task', 'meeting', 'announcement', 'doc'].includes(t),
      );
    return search.search(actor, query.q, { types, limit: query.limit });
  });
}
