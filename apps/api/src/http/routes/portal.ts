/**
 * The client portal's routes.
 *
 * Every one of these is reachable by a guest, so every one takes its scope from the actor
 * and never from the request. There is deliberately no `:organisationId` anywhere below:
 * the only organisation a caller can name is their own, by not naming it at all.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as portal from '../../domains/portal.js';
import * as documentRender from '../../domains/document-render.js';

const idParam = z.object({ id: z.string().uuid() });

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/portal/overview', async (request) => {
    return portal.overview(requireActor(request));
  });

  app.get('/portal/invoices', async (request) => {
    return { items: await portal.listInvoices(requireActor(request)) };
  });

  app.get('/portal/invoices/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return portal.getInvoice(requireActor(request), id);
  });

  app.get('/portal/quotations', async (request) => {
    return { items: await portal.listQuotations(requireActor(request)) };
  });

  app.get('/portal/quotations/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return portal.getQuotation(requireActor(request), id);
  });

  app.get('/portal/payments', async (request) => {
    return { items: await portal.listPayments(requireActor(request)) };
  });

  app.get('/portal/next-payment', async (request) => {
    return { next: await portal.nextPayment(requireActor(request)) };
  });

  /**
   * Permanent authenticated PDF access for the client's commercial documents.
   * Scope is proven through the portal domain before the general renderer sees the id.
   */
  app.get('/portal/documents/:kind/:id/pdf', async (request, reply) => {
    const actor = requireActor(request);
    const { kind, id } = parse(
      z.object({ kind: z.enum(['invoice', 'quotation', 'receipt']), id: z.string().uuid() }),
      request.params,
    );

    if (kind === 'invoice') await portal.getInvoice(actor, id);
    else if (kind === 'quotation') await portal.getQuotation(actor, id);
    else await portal.getPayment(actor, id);

    const model = await documentRender.buildModel(kind, id);
    if (!model) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    model.signatures = await documentRender.signatureSlots(kind, id);
    const profile = await documentRender.billingProfile(actor.companyId);
    const safeNumber = (model.number || kind).replace(/[^A-Za-z0-9._-]/g, '_');

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${safeNumber}.pdf"`)
      .header('cache-control', 'private, no-store')
      .send(documentRender.renderPdf(model, profile));
  });

  app.get('/portal/notices', async (request) => {
    return { items: await portal.listNotices(requireActor(request)) };
  });

  /** The client's projects, and the work inside one of them. Read-only throughout. */
  app.get('/portal/projects', async (request) => {
    return { items: await portal.listProjects(requireActor(request)) };
  });

  app.get('/portal/projects/:id/tasks', async (request) => {
    const { id } = parse(idParam, request.params);
    return { items: await portal.listTasks(requireActor(request), id) };
  });

  app.get('/portal/tasks/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return portal.getTask(requireActor(request), id);
  });

  app.get('/portal/pages', async (request) => {
    return { items: await portal.listPages(requireActor(request)) };
  });

  app.get('/portal/uploads', async (request) => {
    return { items: await portal.listUploads(requireActor(request)) };
  });

  /**
   * The one thing a client writes.
   *
   * Takes a file id rather than the bytes: the upload itself goes through the ordinary
   * file route, which does the scanning and the quota accounting, and this records what
   * the file was for once it is safely stored.
   */
  app.post('/portal/uploads', async (request, reply) => {
    const input = parse(
      z.object({
        fileId: z.string().uuid(),
        kind: z.enum(['invoice', 'payment_proof', 'other']).optional(),
        note: z.string().max(2000).nullable().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return portal.submitUpload(requireActor(request), input);
  });
}
