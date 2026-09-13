/**
 * Service management routes beyond the ticket core: knowledge base, request forms,
 * problem and change management, licences and contracts, and email-to-ticket.
 *
 * Authorization lives in the domains. The inbound email webhook is the one anonymous
 * route; it is registered in its own scope with a raw-body parser, because its signature
 * covers the exact bytes that were sent and must not be checked against re-serialised JSON.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { enforce } from '../../core/ratelimit.js';
import { expectedVersion, requireActor } from '../context.js';
import * as knowledge from '../../domains/knowledge.js';
import * as service from '../../domains/service.js';
import * as changes from '../../domains/changes.js';
import * as itam from '../../domains/itam.js';
import * as inbound from '../../domains/inbound-email.js';

const idParam = z.object({ id: z.string().uuid() });
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-14');
const isoDateTime = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/));
const longText = z.string().max(20000);

const articleBody = z.object({
  title: z.string().trim().min(3).max(300),
  summary: z.string().max(500).nullable().optional(),
  body: z.string().max(200_000),
  audience: z.enum(['internal', 'public']).optional(),
  queueId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
});

const formField = z.object({
  key: z.string().min(1).max(40),
  label: z.string().max(120),
  type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'checkbox']),
  required: z.boolean().optional(),
  options: z.array(z.string().max(120)).max(50).optional(),
  help: z.string().max(200).optional(),
});

const changeBody = z.object({
  title: z.string().trim().min(3).max(300),
  description: z.string().trim().min(1).max(20000),
  changeType: z.enum(['standard', 'normal', 'emergency']).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  impact: longText.nullable().optional(),
  implementationPlan: longText.nullable().optional(),
  rollbackPlan: longText.nullable().optional(),
  testPlan: longText.nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  queueId: z.string().uuid().nullable().optional(),
  plannedStart: isoDateTime.nullable().optional(),
  plannedEnd: isoDateTime.nullable().optional(),
});

const licenceBody = z.object({
  name: z.string().trim().min(2).max(200),
  vendorId: z.string().uuid().nullable().optional(),
  licenceType: z.enum(['subscription', 'perpetual', 'open_source', 'trial']).optional(),
  seats: z.number().int().min(0).max(1_000_000).nullable().optional(),
  cost: z.number().min(0).max(1e10).nullable().optional(),
  currency: z.string().length(3).optional(),
  billingPeriod: z.enum(['monthly', 'yearly', 'one_off']).nullable().optional(),
  renewsOn: isoDay.nullable().optional(),
  managedAt: z.string().max(300).nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'expired', 'cancelled']).optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const contractBody = z.object({
  vendorId: z.string().uuid(),
  title: z.string().trim().min(2).max(200),
  reference: z.string().max(120).nullable().optional(),
  startsOn: isoDay.nullable().optional(),
  endsOn: isoDay.nullable().optional(),
  noticeDays: z.number().int().min(0).max(3650).optional(),
  autoRenews: z.boolean().optional(),
  value: z.number().min(0).max(1e12).nullable().optional(),
  currency: z.string().length(3).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  documentFileId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'ended', 'cancelled']).optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export async function serviceManagementRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------------- knowledge */

  app.get('/service/knowledge', async (request) => {
    const q = parse(z.object({
      q: z.string().max(200).optional(),
      status: z.enum(['draft', 'published', 'archived']).optional(),
      audience: z.enum(['internal', 'public']).optional(),
      queueId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }), request.query);
    return knowledge.listArticles(requireActor(request), q);
  });

  app.get('/service/knowledge/suggest', async (request) => {
    const { q } = parse(z.object({ q: z.string().max(300) }), request.query);
    return { items: await knowledge.suggest(requireActor(request), q) };
  });

  app.post('/service/knowledge', async (request, reply) => {
    reply.code(201);
    return knowledge.createArticle(requireActor(request), parse(articleBody, request.body));
  });

  app.get('/service/knowledge/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return knowledge.getArticle(requireActor(request), id);
  });

  app.patch('/service/knowledge/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return knowledge.updateArticle(requireActor(request), id, parse(articleBody.partial(), request.body), expectedVersion(request) ?? undefined);
  });

  app.post('/service/knowledge/:id/status', async (request) => {
    const { id } = parse(idParam, request.params);
    const { status } = parse(z.object({ status: z.enum(['draft', 'published', 'archived']) }), request.body);
    return knowledge.setArticleStatus(requireActor(request), id, status);
  });

  app.post('/service/knowledge/:id/vote', async (request) => {
    const { id } = parse(idParam, request.params);
    const { helpful } = parse(z.object({ helpful: z.boolean() }), request.body);
    return knowledge.vote(requireActor(request), id, helpful);
  });

  // Portal: public, published articles only (enforced in the domain for guests).
  app.get('/portal/knowledge', async (request) => {
    const { q } = parse(z.object({ q: z.string().max(200).optional() }), request.query);
    return knowledge.listArticles(requireActor(request), { q, limit: 50 });
  });
  app.get('/portal/knowledge/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return knowledge.getArticle(requireActor(request), id);
  });
  app.post('/portal/knowledge/:id/vote', async (request) => {
    const { id } = parse(idParam, request.params);
    const { helpful } = parse(z.object({ helpful: z.boolean() }), request.body);
    return knowledge.vote(requireActor(request), id, helpful);
  });

  /* ---------------------------------------------------- ticket relationships */

  app.put('/service/categories/:id/form', async (request) => {
    const { id } = parse(idParam, request.params);
    const { fields } = parse(z.object({ fields: z.array(formField).max(20) }), request.body);
    return service.setCategoryForm(requireActor(request), id, fields);
  });

  app.post('/service/tickets/:id/articles', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { articleId } = parse(z.object({ articleId: z.string().uuid() }), request.body);
    reply.code(201);
    return service.linkArticle(requireActor(request), id, articleId);
  });

  app.put('/service/tickets/:id/problem', async (request) => {
    const { id } = parse(idParam, request.params);
    const { problemId } = parse(z.object({ problemId: z.string().uuid().nullable() }), request.body);
    return service.linkProblem(requireActor(request), id, problemId);
  });

  app.patch('/service/tickets/:id/problem-record', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ rootCause: longText.nullable().optional(), workaround: longText.nullable().optional() }), request.body);
    return service.updateProblemRecord(requireActor(request), id, input);
  });

  app.post('/service/tickets/:id/assets', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { assetId } = parse(z.object({ assetId: z.string().uuid() }), request.body);
    reply.code(201);
    return service.linkAsset(requireActor(request), id, assetId);
  });

  app.delete('/service/tickets/:id/assets/:assetId', async (request) => {
    const { id, assetId } = parse(z.object({ id: z.string().uuid(), assetId: z.string().uuid() }), request.params);
    return service.linkAsset(requireActor(request), id, assetId, true);
  });

  app.get('/service/assets/:id/tickets', async (request) => {
    const { id } = parse(idParam, request.params);
    return { items: await service.ticketsForAsset(requireActor(request), id) };
  });

  /* ---------------------------------------------------------------- changes */

  app.get('/service/changes', async (request) => {
    const q = parse(z.object({
      status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'in_progress', 'implemented', 'failed', 'cancelled', 'closed', 'upcoming', 'open']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(100),
    }), request.query);
    return changes.listChanges(requireActor(request), q);
  });

  app.post('/service/changes', async (request, reply) => {
    reply.code(201);
    return changes.createChange(requireActor(request), parse(changeBody, request.body));
  });

  app.get('/service/changes/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return changes.getChange(requireActor(request), id);
  });

  app.patch('/service/changes/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return changes.updateChange(requireActor(request), id, parse(changeBody.partial(), request.body), expectedVersion(request) ?? undefined);
  });

  app.post('/service/changes/:id/submit', async (request) => {
    const { id } = parse(idParam, request.params);
    return changes.submitChange(requireActor(request), id, request.correlationId);
  });

  app.post('/service/changes/:id/transition', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({
      action: z.enum(['schedule', 'start', 'complete', 'close', 'cancel']),
      plannedStart: isoDateTime.optional(),
      plannedEnd: isoDateTime.optional(),
      outcome: z.enum(['successful', 'failed', 'rolled_back']).optional(),
      notes: z.string().max(5000).nullable().optional(),
    }), request.body);
    return changes.transition(requireActor(request), id, input.action, input);
  });

  app.post('/service/changes/:id/tickets', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const { ticketId } = parse(z.object({ ticketId: z.string().uuid() }), request.body);
    reply.code(201);
    return changes.linkTicket(requireActor(request), id, ticketId);
  });

  app.delete('/service/changes/:id/tickets/:ticketId', async (request) => {
    const { id, ticketId } = parse(z.object({ id: z.string().uuid(), ticketId: z.string().uuid() }), request.params);
    return changes.linkTicket(requireActor(request), id, ticketId, true);
  });

  /* ------------------------------------------------- licences and contracts */

  app.get('/service/licences', async (request) => {
    const q = parse(z.object({ status: z.enum(['active', 'expired', 'cancelled']).optional(), q: z.string().max(200).optional() }), request.query);
    return { items: await itam.listLicences(requireActor(request), q) };
  });
  app.post('/service/licences', async (request, reply) => {
    reply.code(201);
    return itam.saveLicence(requireActor(request), null, parse(licenceBody, request.body));
  });
  app.put('/service/licences/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return itam.saveLicence(requireActor(request), id, parse(licenceBody, request.body));
  });
  app.get('/service/licences/:id/holders', async (request) => {
    const { id } = parse(idParam, request.params);
    return { items: await itam.licenceHolders(requireActor(request), id) };
  });
  app.post('/service/licences/:id/holders', async (request) => {
    const { id } = parse(idParam, request.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), request.body);
    return itam.assignLicence(requireActor(request), id, userId);
  });
  app.delete('/service/licences/:id/holders/:userId', async (request) => {
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), request.params);
    return itam.assignLicence(requireActor(request), id, userId, true);
  });
  app.get('/service/licences/held-by/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return { items: await itam.licencesHeldBy(requireActor(request), id) };
  });

  app.get('/service/contracts', async (request) => {
    const q = parse(z.object({ status: z.enum(['active', 'ended', 'cancelled']).optional(), vendorId: z.string().uuid().optional() }), request.query);
    return { items: await itam.listContracts(requireActor(request), q) };
  });
  app.post('/service/contracts', async (request, reply) => {
    reply.code(201);
    return itam.saveContract(requireActor(request), null, parse(contractBody, request.body));
  });
  app.put('/service/contracts/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return itam.saveContract(requireActor(request), id, parse(contractBody, request.body));
  });
  app.get('/service/contracts/:id/document', async (request) => {
    const { id } = parse(idParam, request.params);
    return itam.contractDocument(requireActor(request), id);
  });

  app.get('/service/expiring', async (request) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(60) }), request.query);
    return itam.expiring(requireActor(request), days);
  });

  /* --------------------------------------------------------- email-to-ticket */

  app.get('/service/inbound-email', async (request) => inbound.getConfig(requireActor(request)));

  app.post('/service/inbound-email/rotate', async (request) => {
    const { queueId } = parse(z.object({ queueId: z.string().uuid() }), request.body);
    return inbound.rotate(requireActor(request), queueId);
  });

  app.patch('/service/inbound-email', async (request) => {
    const input = parse(z.object({ isActive: z.boolean().optional(), queueId: z.string().uuid().optional() }), request.body);
    return inbound.setActive(requireActor(request), input);
  });

  await app.register(async (scope) => {
    // Raw text for this route only: the HMAC is over the bytes that were sent.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1_000_000 }, (_req, body, done) => done(null, body));
    scope.post('/service/inbound-email/:key', async (request, reply) => {
      const { key } = parse(z.object({ key: z.string().regex(/^[a-f0-9]{32}$/) }), request.params);
      await enforce(`inbound-email:${key}`, 120, 60);
      const signature = request.headers['x-infinity-signature'];
      const timestamp = request.headers['x-infinity-timestamp'];
      const result = await inbound.receive(
        key,
        typeof request.body === 'string' ? request.body : '',
        typeof signature === 'string' ? signature : undefined,
        typeof timestamp === 'string' ? timestamp : undefined,
      );
      reply.code(result.outcome === 'created' ? 201 : 200);
      return result;
    });
  });
}
