/**
 * Administration, audit, object streaming and provider webhook endpoints.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema, parse } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as admin from '../../domains/admin.js';
import { config } from '../../core/config.js';
import { storage, verifyLocalObjectSignature } from '../../adapters/storage.js';
import { forbidden, notFound } from '../../core/errors.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/company', async (request) => admin.companySettings(requireActor(request)));

  app.patch('/admin/company', async (request) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        name: z.string().min(1).max(200).optional(),
        legalName: z.string().max(200).nullable().optional(),
        settings: z.record(z.unknown()).optional(),
      }),
      request.body,
    );
    return admin.updateSettings(actor, input);
  });

  app.post('/admin/company/domains', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(z.object({ domain: z.string().min(3).max(253) }), request.body);
    reply.code(201);
    return admin.addVerifiedDomain(actor, input.domain);
  });

  app.get('/admin/groups', async (request) => ({ items: await admin.listGroups(requireActor(request)) }));

  app.post('/admin/groups', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() }),
      request.body,
    );
    reply.code(201);
    return admin.createGroup(actor, input.name, input.description);
  });

  app.put('/admin/groups/:id/members', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(z.object({ userIds: z.array(z.string().uuid()).max(5000) }), request.body);
    await admin.setGroupMembers(actor, id, input.userIds);
    return reply.code(204).send();
  });

  app.get('/admin/operations', async (request) => admin.operationsSnapshot(requireActor(request)));

  app.get('/audit/events', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      paginationSchema.extend({
        action: z.string().max(80).optional(),
        actorId: z.string().uuid().optional(),
        resourceType: z.string().max(40).optional(),
        resourceId: z.string().uuid().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }),
      request.query,
    );
    return admin.readAudit(actor, query);
  });

  app.get('/audit/export', async (request, reply) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({ from: z.string().datetime(), to: z.string().datetime() }),
      request.query,
    );
    const csv = await admin.exportAudit(actor, query.from, query.to);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-${query.from.slice(0, 10)}.csv"`);
    return csv;
  });
}

/**
 * Signed object streaming for the local storage driver. The signature binds the action,
 * key and expiry, so a URL cannot be edited to reach another object or outlive its window.
 */
export async function objectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/objects/download', async (request, reply) => {
    const query = parse(
      z.object({
        key: z.string().min(1).max(500),
        expires: z.coerce.number().int(),
        signature: z.string().min(16).max(200),
        filename: z.string().max(300).optional(),
      }),
      request.query,
    );
    if (!verifyLocalObjectSignature('download', query.key, query.expires, query.signature)) {
      throw forbidden('This link is invalid or has expired');
    }
    if (!(await storage.exists(query.key))) throw notFound('Object not found');

    reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      // Downloads are never rendered inline, which neutralises stored-HTML payloads.
      .header(
        'content-disposition',
        `attachment; filename="${(query.filename ?? 'download').replace(/["\\]/g, '')}"`,
      )
      .header('cache-control', 'private, no-store');
    return reply.send(await storage.get(query.key));
  });
}


export { config };
