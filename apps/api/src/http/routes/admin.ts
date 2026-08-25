/**
 * Administration, audit, object streaming and provider webhook endpoints.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema, parse } from '../../core/validation.js';
import { requireStepUp } from '../../core/authz.js';
import { requireActor } from '../context.js';
import * as admin from '../../domains/admin.js';
import * as mail from '../../domains/mail.js';
import { config } from '../../core/config.js';
import { mailDriver } from '../../adapters/mail.js';
import { storage, verifyLocalObjectSignature } from '../../adapters/storage.js';
import { forbidden, notFound } from '../../core/errors.js';
import { pool } from '../../core/db.js';
import { enforce } from '../../core/ratelimit.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/company', async (request) => admin.companySettings(requireActor(request)));

  app.patch('/admin/company', async (request) => {
    const actor = requireActor(request);
    requireStepUp(actor, 'settings.update');
    const input = parse(
      z.object({ name: z.string().min(1).max(200).optional(), settings: z.record(z.unknown()).optional() }),
      request.body,
    );
    return admin.updateSettings(actor, input);
  });

  app.post('/admin/company/domains', async (request, reply) => {
    const actor = requireActor(request);
    requireStepUp(actor, 'domain.manage');
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
    requireStepUp(actor, 'audit.export');
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

/**
 * Provider webhooks (blueprint 09). Signature verification and a replay window are
 * mandatory; the endpoint is public but never trusts its body without them.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    // The raw body is kept so the HMAC can be computed over exactly what was sent.
    done(null, { raw: body as string, parsed: safeJson(body as string) });
  });

  app.post('/webhooks/mail', async (request, reply) => {
    await enforce(`webhook:mail:${request.ip}`, 600, 60);
    const payload = request.body as { raw: string; parsed: Record<string, unknown> } | undefined;
    const signature = String(request.headers['x-webhook-signature'] ?? '');
    const timestamp = String(request.headers['x-webhook-timestamp'] ?? '');

    if (!payload || !mailDriver.verifyWebhook(payload.raw, signature, timestamp)) {
      request.log.warn({ ip: request.ip }, 'rejected mail webhook with invalid signature');
      throw forbidden('Invalid webhook signature');
    }

    const event = payload.parsed as {
      type?: string;
      messageId?: string;
      providerMessageId?: string;
      detail?: string;
      message?: Record<string, unknown>;
    };

    switch (event.type) {
      case 'delivered':
      case 'bounced':
      case 'failed': {
        if (!event.messageId) break;
        await mail.markDelivery(
          event.messageId,
          event.type,
          event.detail ?? null,
          event.providerMessageId,
        );
        break;
      }
      case 'inbound': {
        const message = event.message as Record<string, string> | undefined;
        if (!message?.to || !message?.from) break;
        const company = await pool.query<{ id: string }>(
          'SELECT company_id AS id FROM mailboxes WHERE address = $1 LIMIT 1',
          [String(message.to).toLowerCase()],
        );
        const companyId = company.rows[0]?.id;
        if (!companyId) break;
        await mail.ingestInbound({
          companyId,
          toAddress: String(message.to),
          fromAddress: String(message.from),
          fromName: message.fromName,
          subject: message.subject ?? '',
          text: message.text ?? '',
          html: message.html,
          providerMessageId: String(event.providerMessageId ?? message.messageId ?? ''),
          messageIdHeader: message.messageId,
        });
        break;
      }
      default:
        request.log.info({ type: event.type }, 'ignored unrecognised mail webhook event');
    }
    // Always 200 on a verified webhook so the provider does not retry indefinitely.
    return reply.code(200).send({ received: true });
  });
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export { config };
