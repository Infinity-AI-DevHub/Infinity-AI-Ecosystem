/**
 * Expense, budget, vendor and asset routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { clientIp, requireActor, withIdempotency } from '../context.js';
import * as finance from '../../domains/finance.js';
import * as invoicing from '../../domains/invoicing.js';
import * as billingSettings from '../../domains/billing-settings.js';
import * as quotations from '../../domains/quotations.js';
import * as signatures from '../../domains/signatures.js';
import * as documentRender from '../../domains/document-render.js';
import { authorize } from '../../core/authz.js';

const idParam = z.object({ id: z.string().uuid() });
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
// Bounded so a typo cannot commit an absurd figure against a budget.
const amount = z.number().nonnegative().max(1e9);

export async function financeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/expenses/categories', async (request) => {
    const actor = requireActor(request);
    return { items: await finance.listCategories(actor) };
  });

  app.post('/expenses/categories', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        key: z.string().min(1).max(40),
        name: z.string().min(1).max(80),
        limitAmount: amount.nullable().optional(),
        requiresReceiptAbove: amount.optional(),
      }),
      request.body,
    );
    reply.code(201);
    return finance.createCategory(actor, input);
  });

  app.get('/expenses/claims', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        scope: z.enum(['mine', 'all']).default('mine'),
        status: z.string().max(20).optional(),
      }),
      request.query,
    );
    return {
      items: await finance.listClaims(actor, { mine: query.scope === 'mine', status: query.status }),
    };
  });

  app.post('/expenses/claims', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        title: z.string().min(1).max(200),
        currency: z.string().length(3).optional(),
        budgetId: z.string().uuid().nullable().optional(),
        items: z
          .array(
            z.object({
              categoryId: z.string().uuid().nullable().optional(),
              spentOn: dateString,
              merchant: z.string().max(200).nullable().optional(),
              description: z.string().max(500).nullable().optional(),
              amount,
              taxAmount: amount.optional(),
              receiptFileId: z.string().uuid().nullable().optional(),
            }),
          )
          .min(1)
          .max(100),
      }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /expenses/claims', async () => {
      const claim = await finance.createClaim(actor, input);
      return { statusCode: 201, body: claim };
    });
  });

  app.get('/expenses/claims/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return finance.claimWithItems(actor, id);
  });

  app.post('/expenses/claims/:id/submit', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return withIdempotency(request, reply, 'POST /expenses/claims/:id/submit', async () => {
      const claim = await finance.submitClaim(actor, id, request.correlationId);
      return { statusCode: 200, body: claim };
    });
  });

  app.post('/expenses/claims/:id/reimburse', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({ paymentReference: z.string().min(1).max(120) }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /expenses/claims/:id/reimburse', async () => {
      const claim = await finance.reimburseClaim(actor, id, input);
      return { statusCode: 200, body: claim };
    });
  });

  // ---------------------------------------------------------------- budgets

  app.get('/budgets', async (request) => {
    const actor = requireActor(request);
    return { items: await finance.listBudgets(actor) };
  });

  app.post('/budgets', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        name: z.string().min(1).max(120),
        departmentId: z.string().uuid().nullable().optional(),
        periodStart: dateString,
        periodEnd: dateString,
        amount,
        currency: z.string().length(3).optional(),
      }),
      request.body,
    );
    reply.code(201);
    return finance.createBudget(actor, input);
  });

  // ---------------------------------------------------------------- vendors

  app.get('/vendors', async (request) => {
    const actor = requireActor(request);
    return { items: await finance.listVendors(actor) };
  });

  app.post('/vendors', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        name: z.string().min(1).max(200),
        organizationId: z.string().uuid().nullable().optional(),
        contactEmail: z.string().email().max(320).nullable().optional(),
        contactPhone: z.string().max(40).nullable().optional(),
        taxId: z.string().max(60).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return finance.createVendor(actor, input);
  });

  // ---------------------------------------------------------------- assets

  app.get('/assets', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        status: z.string().max(20).optional(),
        assignedTo: z.string().uuid().optional(),
        q: z.string().max(200).optional(),
      }),
      request.query,
    );
    return { items: await finance.listAssets(actor, query) };
  });

  app.post('/assets', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        assetTag: z.string().min(1).max(60),
        name: z.string().min(1).max(200),
        category: z.string().max(60).optional(),
        serialNumber: z.string().max(120).nullable().optional(),
        vendorId: z.string().uuid().nullable().optional(),
        purchasedOn: dateString.nullable().optional(),
        purchaseCost: amount.nullable().optional(),
        currency: z.string().length(3).optional(),
        warrantyUntil: dateString.nullable().optional(),
        location: z.string().max(120).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return finance.createAsset(actor, input);
  });

  app.post('/assets/:id/assign', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        userId: z.string().uuid().nullable(),
        conditionNote: z.string().max(500).nullable().optional(),
      }),
      request.body,
    );
    return finance.assignAsset(actor, id, input);
  });

  app.get('/assets/:id/history', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return { items: await finance.assetHistory(actor, id) };
  });

  /** What a departing person is still holding, asked at offboarding time. */
  app.get('/assets/held-by/:userId', async (request) => {
    const actor = requireActor(request);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), request.params);
    return { items: await finance.assetsHeldBy(actor, userId) };
  });

  /* ---------------------------------------------------------------- invoices */

  app.get('/invoices', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        bucket: z.enum(['all', 'draft', 'open', 'partially_paid', 'paid', 'void', 'overdue', 'outstanding'])
          .default('all'),
        clientOrgId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      request.query,
    );
    return { items: await invoicing.listInvoices(actor, query) };
  });

  app.get('/invoices/summary', async (request) => {
    const actor = requireActor(request);
    return invoicing.summary(actor);
  });

  app.get('/invoices/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return invoicing.getInvoice(actor, id);
  });

  app.post('/invoices', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        clientOrgId: z.string().uuid(),
        projectId: z.string().uuid().nullable().optional(),
        issueDate: dateString,
        dueDate: dateString,
        currency: z.string().length(3).optional(),
        notes: z.string().max(4000).nullable().optional(),
        terms: z.string().max(4000).nullable().optional(),
        remindersEnabled: z.boolean().optional(),
        reminderIntervalDays: z.number().int().min(1).max(90).optional(),
        // At least one line: the total is derived from these and nothing else.
        lines: z.array(z.object({
          description: z.string().min(1).max(500),
          quantity: z.number().positive().max(1e6),
          unitPrice: amount,
          taxRate: z.number().min(0).max(100).optional(),
        })).min(1).max(200),
      }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /invoices', async () => ({
      statusCode: 201,
      body: await invoicing.createInvoice(actor, input),
    }));
  });

  app.post('/invoices/:id/submit', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return withIdempotency(request, reply, 'POST /invoices/:id/submit', async () => ({
      statusCode: 200,
      body: await invoicing.submitInvoice(actor, id),
    }));
  });

  // Releasing an invoice to a client is a super-administrator act, separate from
  // drafting it. The capability check lives in the domain.
  app.patch('/vendors/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return finance.updateVendor(actor, id, parse(
      z.object({
        name: z.string().min(1).max(200).optional(),
        contactEmail: z.string().email().max(320).nullable().optional(),
        contactPhone: z.string().max(40).nullable().optional(),
        taxId: z.string().max(60).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
        status: z.enum(['active', 'archived']).optional(),
      }).strict(), request.body));
  });

  app.delete('/vendors/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await finance.archiveVendor(actor, id);
    return reply.code(204).send();
  });

  app.patch('/budgets/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return finance.updateBudget(actor, id, parse(
      z.object({
        name: z.string().min(1).max(200).optional(),
        amount: z.number().min(0).optional(),
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.enum(['active', 'closed']).optional(),
      }).strict(), request.body));
  });

  app.delete('/budgets/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await finance.closeBudget(actor, id);
    return reply.code(204).send();
  });

  app.patch('/expenses/categories/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return finance.updateCategory(actor, id, parse(
      z.object({
        name: z.string().min(1).max(120).optional(),
        limitAmount: z.number().min(0).nullable().optional(),
        requiresReceiptAbove: z.number().min(0).optional(),
        active: z.boolean().optional(),
      }).strict(), request.body));
  });

  app.patch('/assets/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return finance.updateAsset(actor, id, parse(
      z.object({
        name: z.string().min(1).max(200).optional(),
        category: z.string().max(60).optional(),
        serialNumber: z.string().max(120).nullable().optional(),
        vendorId: z.string().uuid().nullable().optional(),
        purchasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        purchaseCost: z.number().min(0).nullable().optional(),
        warrantyUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        location: z.string().max(200).nullable().optional(),
        notes: z.string().max(4000).nullable().optional(),
        status: z.string().max(30).optional(),
      }).strict(), request.body));
  });

  // ---- quotations -------------------------------------------------------
  app.get('/quotations', async (request) => {
    const actor = requireActor(request);
    const q = request.query as { status?: string; orgId?: string };
    return { items: await quotations.listQuotations(actor, { status: q.status, orgId: q.orgId }) };
  });

  app.get('/quotations/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return quotations.getQuotation(actor, id);
  });

  app.post('/quotations', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        orgId: z.string().uuid(),
        issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        currency: z.string().length(3).optional(),
        summary: z.string().max(4000).nullable().optional(),
        terms: z.string().max(8000).nullable().optional(),
        lines: z.array(z.object({
          description: z.string().min(1).max(500),
          quantity: z.number().positive(),
          unitPrice: z.number().min(0),
          taxRate: z.number().min(0).max(100).optional(),
        })).min(1),
      }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /quotations', async () => ({
      statusCode: 201,
      body: await quotations.createQuotation(actor, input),
    }));
  });

  app.post('/quotations/:id/revise', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        note: z.string().min(1).max(1000),
        summary: z.string().max(4000).nullable().optional(),
        terms: z.string().max(8000).nullable().optional(),
        validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        lines: z.array(z.object({
          description: z.string().min(1).max(500),
          quantity: z.number().positive(),
          unitPrice: z.number().min(0),
          taxRate: z.number().min(0).max(100).optional(),
        })).min(1),
      }),
      request.body,
    );
    return quotations.reviseQuotation(actor, id, input);
  });

  app.post('/quotations/:id/ready', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    await quotations.markReadyToSend(actor, id);
    return reply.code(204).send();
  });

  app.post('/quotations/:id/send', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return quotations.sendQuotation(actor, id);
  });

  app.post('/quotations/:id/accept', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return quotations.acceptQuotation(actor, id);
  });

  app.post('/quotations/:id/decline', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const { reason } = parse(z.object({ reason: z.string().min(1).max(2000) }), request.body);
    await quotations.declineQuotation(actor, id, reason);
    return reply.code(204).send();
  });

  // ---- signatures -------------------------------------------------------
  app.get('/me/signature', async (request) => {
    const actor = requireActor(request);
    return (await signatures.mySignature(actor)) ?? { file_id: null };
  });

  app.put('/me/signature', async (request, reply) => {
    const actor = requireActor(request);
    const { fileId } = parse(z.object({ fileId: z.string().uuid() }), request.body);
    await signatures.saveMySignature(actor, fileId);
    return reply.code(204).send();
  });

  app.get('/signatures/:type/:id', async (request) => {
    const actor = requireActor(request);
    const { type, id } = request.params as { type: signatures.DocumentType; id: string };
    return signatures.verify(actor, type, id);
  });

  app.post('/signatures/:type/:id/sign', async (request) => {
    const actor = requireActor(request);
    const { type, id } = request.params as { type: signatures.DocumentType; id: string };
    const input = parse(
      z.object({
        role: z.enum(['internal_1', 'internal_2']),
        page: z.number().int().min(1).optional(),
        posX: z.number().min(0).max(1).optional(),
        posY: z.number().min(0).max(1).optional(),
        width: z.number().min(0).max(1).optional(),
      }),
      request.body,
    );
    return signatures.signDocument(actor, {
      documentType: type,
      documentId: id,
      ...input,
      // Taken from the request, never from the body: a caller that could state its own
      // address could put anyone's in the record.
      ip: clientIp(request),
      userAgent: request.headers['user-agent'] ?? null,
    });
  });

  app.post('/signatures/:type/:id/request', async (request, reply) => {
    const actor = requireActor(request);
    const { type, id } = request.params as { type: signatures.DocumentType; id: string };
    const input = parse(
      z.object({
        signerUserId: z.string().uuid(),
        note: z.string().max(1000).nullable().optional(),
      }),
      request.body,
    );
    await signatures.requestCountersignature(actor, {
      documentType: type, documentId: id, ...input,
    });
    return reply.code(204).send();
  });

  app.post('/signatures/:type/:id/client', async (request, reply) => {
    const actor = requireActor(request);
    const { type, id } = request.params as { type: signatures.DocumentType; id: string };
    const input = parse(
      z.object({
        role: z.enum(['client_1', 'client_2']),
        signerName: z.string().min(1).max(200),
        signerEmail: z.string().email().max(320).nullable().optional(),
        fileId: z.string().uuid(),
      }),
      request.body,
    );
    await signatures.recordClientSignature(actor, { documentType: type, documentId: id, ...input });
    return reply.code(204).send();
  });

  /**
   * The document as a PDF.
   *
   * The same renderer the email uses, so what somebody downloads is byte-for-byte what
   * the client received rather than a second rendering that can drift from it.
   */
  app.get('/documents/:kind/:id/pdf', async (request, reply) => {
    const actor = requireActor(request);
    const { kind, id } = request.params as { kind: 'invoice' | 'quotation' | 'receipt'; id: string };
    if (!['invoice', 'quotation', 'receipt'].includes(kind)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown document type' } });
    }
    await authorize({
      actor,
      capability: kind === 'quotation' ? 'quotation.read' : 'invoice.read',
      resourceless: true,
    });

    const model = await documentRender.buildModel(kind, id);
    if (!model) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    model.signatures = await documentRender.signatureSlots(kind, id);
    const profile = await documentRender.billingProfile(actor.companyId);

    return reply
      .header('content-type', 'application/pdf')
      // inline, not attachment: people expect to look at it before saving it.
      .header('content-disposition', `inline; filename="${model.number || kind}.pdf"`)
      .header('cache-control', 'no-store')
      .send(documentRender.renderPdf(model, profile));
  });

  app.get('/billing/settings', async (request) => {
    const actor = requireActor(request);
    return billingSettings.getSettings(actor);
  });

  app.patch('/billing/settings', async (request) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        legalName: z.string().max(200).nullable().optional(),
        addressLine1: z.string().max(200).nullable().optional(),
        addressLine2: z.string().max(200).nullable().optional(),
        city: z.string().max(120).nullable().optional(),
        postalCode: z.string().max(30).nullable().optional(),
        country: z.string().max(80).nullable().optional(),
        taxRegistration: z.string().max(60).nullable().optional(),
        contactEmail: z.string().email().max(320).nullable().optional(),
        contactPhone: z.string().max(40).nullable().optional(),
        paymentInstructions: z.string().max(4000).nullable().optional(),
        invoiceFooter: z.string().max(2000).nullable().optional(),
        receiptFooter: z.string().max(2000).nullable().optional(),
        defaultTerms: z.string().max(4000).nullable().optional(),
        defaultDueDays: z.number().int().min(0).max(365).optional(),
        invoicePrefix: z.string().max(12).optional(),
        receiptPrefix: z.string().max(12).optional(),
        accentColour: z.string().max(16).nullable().optional(),
        logoFileId: z.string().uuid().nullable().optional(),
      }).strict(),
      request.body,
    );
    return billingSettings.updateSettings(actor, input);
  });

  app.post('/invoices/:id/approve', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return withIdempotency(request, reply, 'POST /invoices/:id/approve', async () => ({
      statusCode: 200,
      body: await invoicing.approveInvoice(actor, id),
    }));
  });

  app.post('/invoices/:id/reject', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const { reason } = parse(z.object({ reason: z.string().min(4).max(500) }), request.body);
    return invoicing.rejectInvoice(actor, id, reason);
  });

  app.post('/invoices/:id/payments', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        amount: z.number().positive().max(1e9),
        paidOn: dateString,
        method: z.enum(['bank_transfer', 'card', 'cash', 'cheque', 'online', 'other']).optional(),
        reference: z.string().max(120).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
      }),
      request.body,
    );
    // Idempotent: a retried payment must not be recorded twice against a client.
    return withIdempotency(request, reply, 'POST /invoices/:id/payments', async () => ({
      statusCode: 201,
      body: await invoicing.recordPayment(actor, id, input),
    }));
  });

  app.post('/invoices/:id/void', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const { reason } = parse(z.object({ reason: z.string().min(4).max(500) }), request.body);
    await invoicing.voidInvoice(actor, id, reason);
    return { ok: true };
  });

  app.put('/invoices/:id/reminders', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({ enabled: z.boolean(), intervalDays: z.number().int().min(1).max(90) }),
      request.body,
    );
    await invoicing.setReminderPolicy(actor, id, input);
    return { ok: true };
  });

}
