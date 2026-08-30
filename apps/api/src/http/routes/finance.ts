/**
 * Expense, budget, vendor and asset routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor, withIdempotency } from '../context.js';
import * as finance from '../../domains/finance.js';
import * as invoicing from '../../domains/invoicing.js';

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

  app.post('/invoices/:id/issue', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return withIdempotency(request, reply, 'POST /invoices/:id/issue', async () => ({
      statusCode: 200,
      body: await invoicing.issueInvoice(actor, id),
    }));
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
