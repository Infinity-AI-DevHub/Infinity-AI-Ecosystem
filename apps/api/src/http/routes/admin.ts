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
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { one } from '../../core/db.js';

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

  app.patch('/admin/groups/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    return admin.updateGroup(actor, id, parse(
      z.object({
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(1000).optional(),
      }).strict(), request.body));
  });

  app.delete('/admin/groups/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    // Archive: a group is an access decision, and removing it would revoke permissions
    // nobody asked to revoke.
    await admin.archiveGroup(actor, id);
    return reply.code(204).send();
  });

  app.post('/admin/groups', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() }),
      request.body,
    );
    reply.code(201);
    return admin.createGroup(actor, input.name, input.description);
  });

  app.get('/admin/groups/:id/members', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return { userIds: await admin.listGroupMemberIds(actor, id) };
  });

  app.patch('/admin/groups/:id/members', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(z.object({
      addUserIds: z.array(z.string().uuid()).max(5000).default([]),
      removeUserIds: z.array(z.string().uuid()).max(5000).default([]),
    }), request.body);
    await admin.changeGroupMembers(actor, id, input);
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
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: config.limits.uploadMaxBytes },
    (_request, body, done) => done(null, body),
  );

  app.put('/objects/upload', async (request, reply) => {
    const query = parse(
      z.object({
        key: z.string().min(1).max(500),
        expires: z.coerce.number().int(),
        signature: z.string().min(16).max(200),
      }),
      request.query,
    );
    if (!verifyLocalObjectSignature('upload', query.key, query.expires, query.signature)) {
      throw forbidden('This upload link is invalid or has expired');
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('No file content was provided');
    await storage.put(query.key, body);
    return reply.code(204).send();
  });

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

    /*
     * Photographs, logos and signatures are shown in the application, so a handful of
     * image types are served with their real content type and `inline`. Everything else
     * keeps `application/octet-stream; attachment`, which is what stops a stored HTML
     * payload executing on this origin.
     *
     * The allow-list is deliberately short and deliberately excludes SVG: an SVG can
     * carry script, and serving one inline here would hand it this origin.
     *
     * The type is read from the stored version rather than taken from the query, so it
     * cannot be chosen by whoever holds the link.
     */
    const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const stored = await one<{ mime_type: string | null }>(
      'SELECT mime_type FROM file_versions WHERE object_key = $1 LIMIT 1',
      [query.key],
    );
    const mime = stored?.mime_type ?? null;
    const inlineable = mime !== null && INLINE_IMAGE.has(mime);
    const safeName = (query.filename ?? 'download').replace(/["\\]/g, '');

    reply
      .header('content-type', inlineable ? mime : 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `${inlineable ? 'inline' : 'attachment'}; filename="${safeName}"`,
      )
      .header('cache-control', 'private, no-store');
    return reply.send(await storage.get(query.key));
  });
}


export { config };
