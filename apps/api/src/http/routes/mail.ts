/**
 * Mail endpoints (blueprint 08/09).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emailSchema, paginationSchema, parse } from '../../core/validation.js';
import { authorize } from '../../core/authz.js';
import { enforce } from '../../core/ratelimit.js';
import { config } from '../../core/config.js';
import { expectedVersion, requireActor, setVersionHeader, withIdempotency } from '../context.js';
import * as mail from '../../domains/mail.js';

export async function mailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/mail/mailboxes', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'mail.read', resourceless: true });
    const mailbox = await mail.resolveMailbox(actor);
    return {
      mailbox: {
        id: mailbox.id,
        address: mailbox.address,
        displayName: mailbox.display_name,
        provisionState: mailbox.provision_state,
        quotaBytes: Number(mailbox.quota_bytes),
        usedBytes: Number(mailbox.used_bytes),
      },
      folders: await mail.listFolders(mailbox.id),
      stats: await mail.mailboxStats(mailbox.id),
    };
  });

  app.get('/mail/messages', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'mail.read', resourceless: true });
    const query = parse(
      paginationSchema.extend({
        mailboxId: z.string().uuid().optional(),
        folderId: z.string().uuid().optional(),
        folder: z.enum(['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam', 'quarantine']).optional(),
        unreadOnly: z.coerce.boolean().optional(),
      }),
      request.query,
    );
    const mailbox = await mail.resolveMailbox(actor, query.mailboxId, 'read');
    return mail.listMessages(mailbox, {
      folderId: query.folderId,
      folderKind: query.folder,
      unreadOnly: query.unreadOnly,
      limit: query.limit,
      cursor: query.cursor,
    });
  });

  app.get('/mail/messages/:id', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'mail.read', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const query = parse(z.object({ mailboxId: z.string().uuid().optional() }), request.query);
    const mailbox = await mail.resolveMailbox(actor, query.mailboxId, 'read');
    const message = await mail.getMessage(mailbox, id);
    setVersionHeader(reply, message.version);
    return message;
  });

  app.post('/mail/messages', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'mail.send', resourceless: true });
    // Outbound volume is capped per sender to limit damage from a compromised account.
    await enforce(`mail:send:${actor.userId}`, config.limits.mailSendPerHour, 3600);

    return withIdempotency(request, reply, 'POST /mail/messages', async () => {
      const input = parse(
        z.object({
          mailboxId: z.string().uuid().optional(),
          to: z.array(emailSchema).max(200).default([]),
          cc: z.array(emailSchema).max(200).optional(),
          bcc: z.array(emailSchema).max(200).optional(),
          subject: z.string().max(500).default(''),
          bodyText: z.string().max(500_000).default(''),
          bodyHtml: z.string().max(1_000_000).optional(),
          inReplyTo: z.string().max(500).nullable().optional(),
          attachmentFileIds: z.array(z.string().uuid()).max(20).optional(),
          saveAsDraft: z.boolean().optional(),
        }),
        request.body,
      );
      const mailbox = await mail.resolveMailbox(actor, input.mailboxId, 'send');
      const message = await mail.compose(actor, mailbox, input, request.correlationId);
      return { statusCode: 202, body: mail.publicMessage(message) };
    });
  });

  app.patch('/mail/messages/:id', async (request, reply) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'mail.read', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(
      z.object({
        mailboxId: z.string().uuid().optional(),
        isRead: z.boolean().optional(),
        isFlagged: z.boolean().optional(),
        labels: z.array(z.string().max(40)).max(30).optional(),
      }),
      request.body,
    );
    const mailbox = await mail.resolveMailbox(actor, input.mailboxId, 'read');
    const updated = await mail.updateFlags(actor, mailbox, id, input, expectedVersion(request));
    setVersionHeader(reply, updated.version);
    return mail.publicMessage(updated);
  });

  app.post('/mail/messages/:id/move', async (request) => {
    const actor = requireActor(request);
    await authorize({ actor, capability: 'mail.delete', resourceless: true });
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(
      z.object({
        mailboxId: z.string().uuid().optional(),
        folder: z.enum(['inbox', 'archive', 'trash', 'spam']),
      }),
      request.body,
    );
    const mailbox = await mail.resolveMailbox(actor, input.mailboxId, 'read');
    return mail.publicMessage(await mail.moveMessage(actor, mailbox, id, input.folder));
  });
}
