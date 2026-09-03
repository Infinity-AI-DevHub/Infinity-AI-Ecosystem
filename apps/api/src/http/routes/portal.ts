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

  app.get('/portal/notices', async (request) => {
    return { items: await portal.listNotices(requireActor(request)) };
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
