/**
 * Engineering routes: catalogue, dependencies, links, environments, APIs, onboarding
 * checklist, templates, deployments, source control and scorecards.
 *
 * One route is anonymous and carries its own credential:
 *   POST /engineering/scm/:key   GitHub HMAC signature or GitLab token (raw-body scope)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { enforce } from '../../core/ratelimit.js';
import { requireActor } from '../context.js';
import * as engineering from '../../domains/engineering.js';

const idParam = z.object({ id: z.string().uuid() });
const kind = z.enum(['service', 'website', 'library', 'job', 'data', 'mobile']);
const lifecycle = z.enum(['experimental', 'production', 'deprecated']);
const tier = z.enum(['critical', 'high', 'standard']);
const deploymentStatus = z.enum(['in_progress', 'succeeded', 'failed', 'rolled_back']);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const catalogueBody = z.object({
  description: z.string().max(5000).nullable().optional(),
  tier: tier.optional(),
  kind: kind.optional(),
  lifecycle: lifecycle.optional(),
  language: z.string().max(40).nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  teamGroupId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
});

const apiBody = z.object({
  name: z.string().trim().min(2).max(160),
  protocol: z.enum(['rest', 'graphql', 'grpc', 'event', 'soap', 'other']),
  version: z.string().max(40).nullable().optional(),
  lifecycle: z.enum(['draft', 'active', 'deprecated', 'retired']),
  visibility: z.enum(['internal', 'partner', 'public']),
  description: z.string().max(5000).nullable().optional(),
  specUrl: z.string().max(500).nullable().optional(),
  docsUrl: z.string().max(500).nullable().optional(),
});

const environmentBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['production', 'staging', 'development', 'other']),
  url: z.string().max(500).nullable().optional(),
});

const templateBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  kind, tier,
  checklist: z.array(z.string().max(200)).max(40),
  environments: z.array(z.string().max(60)).max(10),
});

export async function engineeringRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------------------------------------- catalogue */

  app.get('/engineering/services', async (request) => {
    const q = parse(z.object({ q: z.string().max(200).optional(), kind: kind.optional(), lifecycle: lifecycle.optional(), mine: bool.optional(), teamId: z.string().uuid().optional(), includeInactive: bool.optional() }), request.query);
    return { items: await engineering.listCatalogue(requireActor(request), q) };
  });
  app.post('/engineering/services', async (request, reply) => {
    const input = parse(catalogueBody.extend({ name: z.string().trim().min(2).max(160), templateId: z.string().uuid().nullable().optional() }), request.body);
    reply.code(201);
    return engineering.createService(requireActor(request), input);
  });
  app.get('/engineering/teams', async (request) => ({ items: await engineering.listTeams(requireActor(request)) }));
  app.get('/engineering/services/:id', async (request) => engineering.getCatalogueEntry(requireActor(request), parse(idParam, request.params).id));
  app.patch('/engineering/services/:id', async (request) => engineering.updateService(requireActor(request), parse(idParam, request.params).id, parse(catalogueBody, request.body)));

  app.post('/engineering/services/:id/dependencies', async (request, reply) => {
    const input = parse(z.object({ dependsOnId: z.string().uuid(), note: z.string().max(200).nullable().optional() }), request.body);
    await engineering.addDependency(requireActor(request), parse(idParam, request.params).id, input);
    reply.code(204);
  });
  app.delete('/engineering/services/:id/dependencies/:dependsOnId', async (request, reply) => {
    const { id, dependsOnId } = parse(z.object({ id: z.string().uuid(), dependsOnId: z.string().uuid() }), request.params);
    await engineering.removeDependency(requireActor(request), id, dependsOnId);
    reply.code(204);
  });

  app.post('/engineering/services/:id/links', async (request, reply) => {
    const input = parse(z.object({ kind: z.enum(['runbook', 'docs', 'dashboard', 'design', 'other']), title: z.string().trim().min(2).max(200), url: z.string().max(500).nullable().optional(), articleId: z.string().uuid().nullable().optional() }), request.body);
    reply.code(201);
    return engineering.addLink(requireActor(request), parse(idParam, request.params).id, input);
  });
  app.delete('/engineering/links/:id', async (request, reply) => {
    await engineering.removeLink(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  app.post('/engineering/services/:id/environments', async (request, reply) => {
    reply.code(201);
    return engineering.saveEnvironment(requireActor(request), parse(idParam, request.params).id, null, parse(environmentBody, request.body));
  });
  app.put('/engineering/services/:id/environments/:envId', async (request) => {
    const { id, envId } = parse(z.object({ id: z.string().uuid(), envId: z.string().uuid() }), request.params);
    return engineering.saveEnvironment(requireActor(request), id, envId, parse(environmentBody, request.body));
  });
  app.delete('/engineering/environments/:id', async (request, reply) => {
    await engineering.removeEnvironment(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  app.post('/engineering/services/:id/checklist', async (request, reply) => {
    const { title } = parse(z.object({ title: z.string().trim().min(2).max(200) }), request.body);
    reply.code(201);
    return engineering.addChecklistItem(requireActor(request), parse(idParam, request.params).id, title);
  });
  app.patch('/engineering/checklist/:id', async (request, reply) => {
    const input = parse(z.object({ done: z.boolean().optional(), remove: z.boolean().optional() }), request.body);
    await engineering.updateChecklistItem(requireActor(request), parse(idParam, request.params).id, input);
    reply.code(204);
  });

  /* -------------------------------------------------------------------- APIs */

  app.get('/engineering/apis', async (request) => {
    const q = parse(z.object({ q: z.string().max(200).optional(), protocol: apiBody.shape.protocol.optional(), lifecycle: apiBody.shape.lifecycle.optional(), visibility: apiBody.shape.visibility.optional() }), request.query);
    return { items: await engineering.listApis(requireActor(request), q) };
  });
  app.post('/engineering/services/:id/apis', async (request, reply) => {
    reply.code(201);
    return engineering.saveApi(requireActor(request), parse(idParam, request.params).id, null, parse(apiBody, request.body));
  });
  app.put('/engineering/services/:id/apis/:apiId', async (request) => {
    const { id, apiId } = parse(z.object({ id: z.string().uuid(), apiId: z.string().uuid() }), request.params);
    return engineering.saveApi(requireActor(request), id, apiId, parse(apiBody, request.body));
  });
  app.delete('/engineering/apis/:id', async (request, reply) => {
    await engineering.deleteApi(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  /* --------------------------------------------------------------- templates */

  app.get('/engineering/templates', async (request) => ({ items: await engineering.listTemplates(requireActor(request)) }));
  app.post('/engineering/templates', async (request, reply) => {
    reply.code(201);
    return engineering.saveTemplate(requireActor(request), null, parse(templateBody, request.body));
  });
  app.put('/engineering/templates/:id', async (request) => engineering.saveTemplate(requireActor(request), parse(idParam, request.params).id, parse(templateBody, request.body)));
  app.delete('/engineering/templates/:id', async (request, reply) => {
    await engineering.deleteTemplate(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  /* ------------------------------------------------------------- deployments */

  app.get('/engineering/deployments', async (request) => {
    const q = parse(z.object({
      serviceId: z.string().uuid().optional(), status: deploymentStatus.optional(), production: bool.optional(),
      days: z.coerce.number().int().min(1).max(365).default(30), limit: z.coerce.number().int().min(1).max(100).default(50),
    }), request.query);
    return engineering.listDeployments(requireActor(request), q);
  });
  app.post('/engineering/services/:id/deployments', async (request, reply) => {
    const input = parse(z.object({
      environmentId: z.string().uuid(), version: z.string().max(80).nullable().optional(), commitSha: z.string().max(64).nullable().optional(),
      status: deploymentStatus, url: z.string().max(500).nullable().optional(), notes: z.string().max(1000).nullable().optional(), changeId: z.string().uuid().nullable().optional(),
    }), request.body);
    reply.code(201);
    return engineering.recordDeployment(requireActor(request), parse(idParam, request.params).id, input);
  });
  app.patch('/engineering/deployments/:id', async (request, reply) => {
    const { status } = parse(z.object({ status: deploymentStatus }), request.body);
    await engineering.updateDeployment(requireActor(request), parse(idParam, request.params).id, status);
    reply.code(204);
  });

  /* ---------------------------------------------------------- source control */

  app.get('/engineering/scm/connections', async (request) => ({ items: await engineering.listConnections(requireActor(request)) }));
  app.post('/engineering/scm/connections', async (request, reply) => {
    const input = parse(z.object({ provider: z.enum(['github', 'gitlab']), name: z.string().trim().min(2).max(120) }), request.body);
    reply.code(201);
    return engineering.createConnection(requireActor(request), input);
  });
  app.patch('/engineering/scm/connections/:id', async (request) => {
    const input = parse(z.object({ name: z.string().trim().min(2).max(120).optional(), isActive: z.boolean().optional(), rotate: z.boolean().optional() }), request.body);
    return engineering.updateConnection(requireActor(request), parse(idParam, request.params).id, input);
  });
  app.get('/engineering/repositories', async (request) => ({ items: await engineering.listRepositories(requireActor(request)) }));
  app.put('/engineering/repositories/:id/service', async (request, reply) => {
    const { serviceId } = parse(z.object({ serviceId: z.string().uuid().nullable() }), request.body);
    await engineering.linkRepository(requireActor(request), parse(idParam, request.params).id, serviceId);
    reply.code(204);
  });

  app.delete('/engineering/deployments/:id', async (request, reply) => {
    await engineering.deleteDeployment(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/engineering/scm/connections/:id', async (request, reply) => {
    await engineering.deleteConnection(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/engineering/repositories/:id', async (request, reply) => {
    await engineering.deleteRepository(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  app.get('/engineering/scorecards', async (request) => engineering.listScorecards(requireActor(request)));

  await app.register(async (scope) => {
    // Signatures are over the exact bytes received.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 5_000_000 }, (_req, body, done) => done(null, body));
    scope.post('/engineering/scm/:key', async (request) => {
      const { key } = parse(z.object({ key: z.string().regex(/^[a-f0-9]{32}$/) }), request.params);
      await enforce(`scm:${key}`, 600, 60);
      const h = (name: string) => { const v = request.headers[name]; return typeof v === 'string' ? v : undefined; };
      return engineering.receiveScmWebhook(key, typeof request.body === 'string' ? request.body : '', {
        'x-hub-signature-256': h('x-hub-signature-256'), 'x-github-event': h('x-github-event'), 'x-github-delivery': h('x-github-delivery'),
        'x-gitlab-token': h('x-gitlab-token'), 'x-gitlab-event': h('x-gitlab-event'), 'x-gitlab-event-uuid': h('x-gitlab-event-uuid'),
      });
    });
  });
}
