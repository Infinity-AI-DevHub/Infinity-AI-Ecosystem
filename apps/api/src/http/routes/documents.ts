/**
 * Document routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { expectedVersion, requireActor, setVersionHeader } from '../context.js';
import { badRequest } from '../../core/errors.js';
import * as documents from '../../domains/documents.js';
import * as attachments from '../../domains/attachments.js';

const idParam = z.object({ id: z.string().uuid() });

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/docs/spaces', async (request) => {
    const actor = requireActor(request);
    return { items: await documents.listSpaces(actor) };
  });

  app.post('/docs/spaces', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        key: z.string().max(40).optional().default(''),
        name: z.string().min(1).max(120),
        description: z.string().max(500).nullable().optional(),
        visibility: z.enum(['company', 'restricted']).optional(),
        colour: z.string().max(16).optional(),
      }),
      request.body,
    );
    reply.code(201);
    return documents.createSpace(actor, input);
  });

  app.get('/docs/spaces/:id/pages', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return { items: await documents.listPages(actor, id) };
  });

  app.post('/docs/pages', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        spaceId: z.string().uuid(),
        title: z.string().min(1).max(300),
        body: z.string().max(500_000).optional(),
        parentId: z.string().uuid().nullable().optional(),
        publish: z.boolean().optional(),
      }),
      request.body,
    );
    const page = await documents.createPage(actor, input);
    setVersionHeader(reply, page.version);
    reply.code(201);
    return page;
  });

  app.get('/docs/pages/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const page = await documents.getPage(actor, id);
    setVersionHeader(reply, page.version);
    return page;
  });

  /**
   * Saving requires If-Match. Two people editing the same page is the normal case for a
   * wiki, so a save that does not say which version it is replacing is a save that will
   * eventually overwrite somebody silently.
   */
  app.patch('/docs/pages/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const version = expectedVersion(request);
    if (version === null) {
      throw badRequest('If-Match is required when saving a page, so a concurrent edit cannot be lost');
    }
    const input = parse(
      z.object({
        title: z.string().min(1).max(300).optional(),
        body: z.string().max(500_000).optional(),
        changeNote: z.string().max(300).nullable().optional(),
        publish: z.boolean().optional(),
      }),
      request.body,
    );
    const page = await documents.updatePage(actor, id, input, version);
    setVersionHeader(reply, page.version);
    return page;
  });

  app.get('/docs/pages/:id/history', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return { items: await documents.pageHistory(actor, id) };
  });

  app.get('/docs/pages/:id/versions/:version', async (request) => {
    const actor = requireActor(request);
    const { id, version } = parse(
      z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }),
      request.params,
    );
    return documents.getVersion(actor, id, version);
  });

  app.post('/docs/pages/:id/versions/:version/restore', async (request, reply) => {
    const actor = requireActor(request);
    const { id, version } = parse(
      z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }),
      request.params,
    );
    const page = await documents.restoreVersion(actor, id, version);
    setVersionHeader(reply, page.version);
    return page;
  });

  app.delete('/docs/pages/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await documents.archivePage(actor, id);
    return reply.code(204).send();
  });

  /* ------------------------------------------------------- page attachments */

  app.get('/docs/pages/:id/attachments', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return { items: await attachments.list(actor, id) };
  });

  app.post('/docs/pages/:id/attachments', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { fileId } = parse(z.object({ fileId: z.string().uuid() }), request.body);
    reply.code(201);
    return attachments.attach(actor, id, fileId);
  });

  app.delete('/docs/pages/:id/attachments/:attachmentId', async (request, reply) => {
    const actor = requireActor(request);
    const { id, attachmentId } = parse(
      z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }),
      request.params,
    );
    await attachments.detach(actor, id, attachmentId);
    reply.code(204);
  });

}
