/**
 * Reliability routes: services, incidents, alerts, on-call, escalation, maintenance,
 * postmortems, reports and the status page.
 *
 * Three routes are anonymous and each has its own credential:
 *   POST /reliability/alerts/:key     HMAC signature over the raw body (raw-body scope)
 *   POST /reliability/heartbeat/:key  the 32-hex key itself
 *   GET  /public/status/:slug         only what a manager marked public, only while enabled
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { enforce } from '../../core/ratelimit.js';
import { expectedVersion, requireActor } from '../context.js';
import * as reliability from '../../domains/reliability.js';
import * as incidents from '../../domains/incidents.js';
import * as alerts from '../../domains/alerts.js';

const idParam = z.object({ id: z.string().uuid() });
const severity = z.enum(['sev1', 'sev2', 'sev3', 'sev4']);
const status = z.enum(['investigating', 'identified', 'monitoring', 'resolved']);
const impact = z.enum(['degraded', 'partial_outage', 'major_outage']);
const dateTime = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/));
const longText = z.string().max(20000);
const serviceImpacts = z.array(z.object({ serviceId: z.string().uuid(), impact })).min(1).max(50);

const serviceBody = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().max(5000).nullable().optional(),
  tier: z.enum(['critical', 'high', 'standard']).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  supportQueueId: z.string().uuid().nullable().optional(),
  escalationPolicyId: z.string().uuid().nullable().optional(),
  isPublic: z.boolean().optional(),
  publicName: z.string().max(160).nullable().optional(),
  isActive: z.boolean().optional(),
});

const scheduleBody = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().min(1).max(64),
  rotation: z.enum(['daily', 'weekly']),
  handoffMinute: z.number().int().min(0).max(1439),
  rotationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  members: z.array(z.string().uuid()).min(1).max(50),
});

const policyBody = z.object({
  name: z.string().trim().min(2).max(120),
  repeatCount: z.number().int().min(0).max(5),
  levels: z.array(z.object({
    delayMinutes: z.number().int().min(0).max(1440),
    targets: z.array(z.object({ type: z.enum(['schedule', 'user']), id: z.string().uuid() })).min(1).max(10),
  })).min(1).max(6),
});

const maintenanceBody = z.object({
  title: z.string().trim().min(3).max(300),
  description: z.string().max(5000).nullable().optional(),
  startsAt: dateTime,
  endsAt: dateTime,
  isPublic: z.boolean().optional(),
  suppressAlerts: z.boolean().optional(),
  serviceIds: z.array(z.string().uuid()).min(1).max(50),
  changeId: z.string().uuid().nullable().optional(),
  cancelled: z.boolean().optional(),
});

const postmortemBody = z.object({
  summary: longText.nullable().optional(), impact: longText.nullable().optional(), rootCause: longText.nullable().optional(),
  wentWell: longText.nullable().optional(), wentWrong: longText.nullable().optional(), lessons: longText.nullable().optional(),
});

export async function reliabilityRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- services */

  app.get('/reliability/services', async (request) => {
    const q = parse(z.object({ includeInactive: z.coerce.boolean().optional() }), request.query);
    return { items: await reliability.listServices(requireActor(request), q) };
  });
  app.post('/reliability/services', async (request, reply) => {
    reply.code(201);
    return reliability.saveService(requireActor(request), null, parse(serviceBody, request.body));
  });
  app.get('/reliability/services/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return reliability.getService(requireActor(request), id);
  });
  app.put('/reliability/services/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return reliability.saveService(requireActor(request), id, parse(serviceBody, request.body));
  });

  app.post('/reliability/services/:id/integrations', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({
      name: z.string().trim().min(2).max(120),
      kind: z.enum(['webhook', 'heartbeat']),
      incidentSeverity: z.enum(['critical', 'warning']).nullable().optional(),
      heartbeatMinutes: z.number().int().min(1).max(10080).nullable().optional(),
    }), request.body);
    reply.code(201);
    return alerts.createIntegration(requireActor(request), id, input);
  });
  app.patch('/reliability/integrations/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({
      name: z.string().trim().min(2).max(120).optional(),
      isActive: z.boolean().optional(),
      incidentSeverity: z.enum(['critical', 'warning']).nullable().optional(),
      heartbeatMinutes: z.number().int().min(1).max(10080).optional(),
      rotate: z.boolean().optional(),
    }), request.body);
    return alerts.updateIntegration(requireActor(request), id, input);
  });

  app.delete('/reliability/services/:id', async (request, reply) => {
    await reliability.deleteService(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/reliability/integrations/:id', async (request, reply) => {
    await alerts.deleteIntegration(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/reliability/schedules/:id', async (request, reply) => {
    await reliability.deleteSchedule(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/reliability/escalation-policies/:id', async (request, reply) => {
    await reliability.deletePolicy(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/reliability/maintenance/:id', async (request, reply) => {
    await reliability.deleteMaintenance(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  app.get('/reliability/alerts', async (request) => {
    const q = parse(z.object({
      status: z.enum(['firing', 'resolved']).optional(),
      serviceId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }), request.query);
    return { items: await alerts.listAlerts(requireActor(request), q) };
  });

  /* --------------------------------------------------------------- incidents */

  app.get('/reliability/incidents', async (request) => {
    const q = parse(z.object({
      status: z.enum(['open', 'resolved', 'all']).optional(),
      serviceId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }), request.query);
    return { items: await incidents.listIncidents(requireActor(request), q) };
  });
  app.post('/reliability/incidents', async (request, reply) => {
    const input = parse(z.object({
      title: z.string().trim().min(3).max(300),
      severity,
      summary: longText.nullable().optional(),
      services: serviceImpacts,
      commanderId: z.string().uuid().nullable().optional(),
    }), request.body);
    const actor = requireActor(request);
    const created = await incidents.declareIncident(actor, input);
    reply.code(201);
    return incidents.getIncident(actor, created.id);
  });
  app.get('/reliability/incidents/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return incidents.getIncident(requireActor(request), id);
  });
  app.patch('/reliability/incidents/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({
      status: status.optional(), severity: severity.optional(), title: z.string().trim().min(3).max(300).optional(),
      summary: longText.nullable().optional(), customerImpact: longText.nullable().optional(),
      commanderId: z.string().uuid().nullable().optional(), isPublic: z.boolean().optional(),
      publicTitle: z.string().max(300).nullable().optional(), services: serviceImpacts.optional(),
    }), request.body);
    return incidents.updateIncident(requireActor(request), id, input, expectedVersion(request) ?? undefined);
  });
  app.post('/reliability/incidents/:id/updates', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ body: z.string().trim().min(1).max(20000), visibility: z.enum(['internal', 'public']), status: status.optional() }), request.body);
    reply.code(201);
    return incidents.postUpdate(requireActor(request), id, input);
  });
  app.post('/reliability/incidents/:id/acknowledge', async (request) => {
    const { id } = parse(idParam, request.params);
    return incidents.acknowledge(requireActor(request), id);
  });
  app.post('/reliability/incidents/:id/join', async (request) => {
    const { id } = parse(idParam, request.params);
    const { role } = parse(z.object({ role: z.enum(['responder', 'communications', 'subject_expert']).optional() }), request.body ?? {});
    return incidents.join(requireActor(request), id, role);
  });
  app.post('/reliability/incidents/:id/responders', async (request) => {
    const { id } = parse(idParam, request.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), request.body);
    return incidents.addResponder(requireActor(request), id, userId);
  });
  app.post('/reliability/incidents/:id/tickets', async (request) => {
    const { id } = parse(idParam, request.params);
    const { ticketId } = parse(z.object({ ticketId: z.string().uuid() }), request.body);
    return incidents.linkTicket(requireActor(request), id, ticketId);
  });
  app.delete('/reliability/incidents/:id/tickets/:ticketId', async (request) => {
    const { id, ticketId } = parse(z.object({ id: z.string().uuid(), ticketId: z.string().uuid() }), request.params);
    return incidents.linkTicket(requireActor(request), id, ticketId, true);
  });
  app.post('/reliability/incidents/:id/problem', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ queueId: z.string().uuid().nullable().optional() }), request.body ?? {});
    reply.code(201);
    return incidents.createProblem(requireActor(request), id, input);
  });

  app.get('/reliability/incidents/:id/postmortem', async (request) => {
    const { id } = parse(idParam, request.params);
    return incidents.getPostmortem(requireActor(request), id);
  });
  app.put('/reliability/incidents/:id/postmortem', async (request) => {
    const { id } = parse(idParam, request.params);
    return incidents.savePostmortem(requireActor(request), id, parse(postmortemBody, request.body));
  });
  app.post('/reliability/incidents/:id/postmortem/publish', async (request) => {
    const { id } = parse(idParam, request.params);
    return incidents.savePostmortem(requireActor(request), id, parse(postmortemBody, request.body ?? {}), true);
  });
  app.post('/reliability/incidents/:id/postmortem/actions', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ title: z.string().trim().min(3).max(300), projectId: z.string().uuid(), ownerId: z.string().uuid().nullable().optional() }), request.body);
    reply.code(201);
    return incidents.addAction(requireActor(request), id, input, request.correlationId);
  });

  /* ---------------------------------------------------------- on-call & escalation */

  app.get('/reliability/schedules', async (request) => ({ items: await reliability.listSchedules(requireActor(request)) }));
  app.post('/reliability/schedules', async (request, reply) => {
    reply.code(201);
    return reliability.saveSchedule(requireActor(request), null, parse(scheduleBody, request.body));
  });
  app.put('/reliability/schedules/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return reliability.saveSchedule(requireActor(request), id, parse(scheduleBody, request.body));
  });
  app.post('/reliability/schedules/:id/overrides', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ userId: z.string().uuid(), startsAt: dateTime, endsAt: dateTime, reason: z.string().max(300).nullable().optional() }), request.body);
    reply.code(201);
    return reliability.addOverride(requireActor(request), id, input);
  });
  app.delete('/reliability/overrides/:id', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await reliability.removeOverride(requireActor(request), id);
    return reply.code(204).send();
  });

  app.get('/reliability/escalation-policies', async (request) => ({ items: await reliability.listPolicies(requireActor(request)) }));
  app.post('/reliability/escalation-policies', async (request, reply) => {
    reply.code(201);
    return reliability.savePolicy(requireActor(request), null, parse(policyBody, request.body));
  });
  app.put('/reliability/escalation-policies/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return reliability.savePolicy(requireActor(request), id, parse(policyBody, request.body));
  });

  /* ------------------------------------------------------------ maintenance */

  app.get('/reliability/maintenance', async (request) => {
    const { scope } = parse(z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') }), request.query);
    return { items: await reliability.listMaintenance(requireActor(request), scope) };
  });
  app.post('/reliability/maintenance', async (request, reply) => {
    reply.code(201);
    return reliability.saveMaintenance(requireActor(request), null, parse(maintenanceBody, request.body));
  });
  app.put('/reliability/maintenance/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return reliability.saveMaintenance(requireActor(request), id, parse(maintenanceBody, request.body));
  });

  /* ---------------------------------------------------- status and reports */

  app.get('/reliability/status', async (request) => reliability.internalStatus(requireActor(request)));
  app.get('/reliability/status-page', async (request) => reliability.getStatusPageSettings(requireActor(request)));
  app.put('/reliability/status-page', async (request) => {
    const input = parse(z.object({ slug: z.string().min(3).max(60), title: z.string().trim().min(2).max(160), intro: z.string().max(500).nullable().optional(), isEnabled: z.boolean() }), request.body);
    return reliability.saveStatusPage(requireActor(request), input);
  });
  app.get('/reliability/report', async (request) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), request.query);
    return reliability.report(requireActor(request), days);
  });

  /* --------------------------------------------------------------- anonymous */

  app.get('/public/status/:slug', async (request) => {
    const { slug } = parse(z.object({ slug: z.string().regex(/^[a-z0-9-]{3,60}$/) }), request.params);
    await enforce(`status-page:${request.ip}`, 120, 60);
    return reliability.publicStatus(slug);
  });

  app.post('/reliability/heartbeat/:key', async (request) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-f0-9]{32}$/) }), request.params);
    await enforce(`heartbeat:${key}`, 60, 60);
    return alerts.receiveHeartbeat(key);
  });

  await app.register(async (scope) => {
    // Raw body for signature verification, as for email-to-ticket.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256_000 }, (_req, body, done) => done(null, body));
    scope.post('/reliability/alerts/:key', async (request, reply) => {
      const { key } = parse(z.object({ key: z.string().regex(/^[a-f0-9]{32}$/) }), request.params);
      await enforce(`alerts:${key}`, 300, 60);
      const signature = request.headers['x-infinity-signature'];
      const timestamp = request.headers['x-infinity-timestamp'];
      const result = await alerts.receiveWebhook(
        key,
        typeof request.body === 'string' ? request.body : '',
        typeof signature === 'string' ? signature : undefined,
        typeof timestamp === 'string' ? timestamp : undefined,
      );
      reply.code(result.outcome === 'incident' ? 201 : 200);
      return result;
    });
  });
}
