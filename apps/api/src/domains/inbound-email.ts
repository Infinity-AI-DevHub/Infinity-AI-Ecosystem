/**
 * Email-to-ticket.
 *
 * Workspace does not receive mail itself - that is Infinity Mail's server, or whatever
 * mail system the company runs. That system forwards each message to a signed webhook,
 * and this module turns it into a ticket or a reply.
 *
 * The rules, in the order they are checked:
 *
 *   1. The request must carry a valid HMAC-SHA256 of `timestamp.body`, using the company's
 *      inbound secret, and a timestamp within five minutes. An unsigned or replayed call
 *      is refused before anything is read.
 *   2. The same Message-ID is processed once. A redelivered webhook is recorded as a
 *      duplicate and does nothing else.
 *   3. The sender must already be an active person in the company - an employee or a
 *      client contact. Mail from anyone else is recorded and refused, never turned into
 *      an account. Anyone can forge a From header, so this is a relevance filter, not
 *      authentication: the webhook signature is what establishes that the message came
 *      through the company's own mail system, which is expected to have checked SPF,
 *      DKIM and DMARC before forwarding.
 *   4. "[SD-123]" in the subject makes the message a reply on that ticket, if the sender
 *      may reply to it and it is not closed. Otherwise it opens a new ticket in the
 *      configured queue.
 *
 * The secret is shown once when generated, stored encrypted, and identified afterwards by
 * a short fingerprint only.
 */
import { newId, one, pool } from '../core/db.js';
import { randomBytes } from 'node:crypto';
import { notFound, unauthenticated, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { decryptField, encryptField, generateToken, hmacSignature, safeEqual, sha256 } from '../core/crypto.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const MAX_SKEW_SECONDS = 300;

export async function getConfig(actor: Actor) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const row = await one<{ queue_id: string; queue_name: string; endpoint_key: string; secret_fingerprint: string; is_active: number; last_received_at: Date | null; rotated_at: Date }>(
    `SELECT e.queue_id, q.name AS queue_name, e.endpoint_key, e.secret_fingerprint, e.is_active, e.last_received_at, e.rotated_at
       FROM service_inbound_email e JOIN service_queues q ON q.id = e.queue_id WHERE e.company_id = $1`, [actor.companyId]);
  const recent = await pool.query<{ from_address: string; subject: string | null; outcome: string; ticket_id: string | null; detail: string | null; received_at: Date }>(
    `SELECT from_address, subject, outcome, ticket_id, detail, received_at FROM service_inbound_messages
      WHERE company_id = $1 ORDER BY received_at DESC LIMIT 20`, [actor.companyId]);
  return {
    configured: Boolean(row),
    queueId: row?.queue_id ?? null,
    queueName: row?.queue_name ?? null,
    endpoint: row ? `${config.apiUrl}/api/v1/service/inbound-email/${row.endpoint_key}` : null,
    secretFingerprint: row?.secret_fingerprint ?? null,
    isActive: row ? Boolean(row.is_active) : false,
    lastReceivedAt: row?.last_received_at ?? null,
    rotatedAt: row?.rotated_at ?? null,
    recent: recent.rows.map((r) => ({ from: r.from_address, subject: r.subject, outcome: r.outcome, ticketId: r.ticket_id, detail: r.detail, receivedAt: r.received_at })),
  };
}

/** Creates or rotates the channel. The plaintext secret is returned this once only. */
export async function rotate(actor: Actor, queueId: string) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const queue = await one<{ is_active: number }>('SELECT is_active FROM service_queues WHERE id = $1 AND company_id = $2', [queueId, actor.companyId]);
  if (!queue || !queue.is_active) throw unprocessable('Choose an active queue', [{ field: 'queueId', message: 'Queue not available' }]);
  const secret = generateToken(32);
  const fingerprint = sha256(secret).slice(0, 12);
  const existing = await one<{ endpoint_key: string }>('SELECT endpoint_key FROM service_inbound_email WHERE company_id = $1', [actor.companyId]);
  const endpointKey = existing?.endpoint_key ?? randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO service_inbound_email (company_id, queue_id, endpoint_key, secret_encrypted, secret_fingerprint, is_active, rotated_by, rotated_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,NOW(3))
     ON DUPLICATE KEY UPDATE queue_id = VALUES(queue_id), secret_encrypted = VALUES(secret_encrypted),
       secret_fingerprint = VALUES(secret_fingerprint), is_active = 1, rotated_by = VALUES(rotated_by), rotated_at = NOW(3)`,
    [actor.companyId, queueId, endpointKey, encryptField(secret), fingerprint, actor.userId],
  );
  await auditFromActor(actor, existing ? 'service.inbound.rotate' : 'service.inbound.create', { resourceType: 'service_inbound_email', metadata: { queueId, fingerprint } });
  return { ...(await getConfig(actor)), secret };
}

export async function setActive(actor: Actor, input: { isActive?: boolean; queueId?: string }) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  if (input.queueId && !(await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2 AND is_active = 1', [input.queueId, actor.companyId]))) {
    throw unprocessable('Choose an active queue', [{ field: 'queueId', message: 'Queue not available' }]);
  }
  const res = await pool.query(
    'UPDATE service_inbound_email SET is_active = COALESCE($2, is_active), queue_id = COALESCE($3, queue_id) WHERE company_id = $1',
    [actor.companyId, input.isActive === undefined ? null : input.isActive, input.queueId ?? null],
  );
  if (res.rowCount === 0) throw notFound('Email-to-ticket is not set up yet');
  await auditFromActor(actor, 'service.inbound.update', { resourceType: 'service_inbound_email', metadata: input });
  return getConfig(actor);
}

export type InboundMessage = {
  messageId: string;
  from: string;
  subject: string;
  text: string;
};

/** Pulls the address out of `"Name" <a@b.c>`. */
export function senderAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1]! : from).trim().toLowerCase();
}

/** Drops the quoted history a mail client appends to a reply. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l) => /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^>/.test(l));
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim();
}

export async function receive(endpointKey: string, rawBody: string, signature: string | undefined, timestamp: string | undefined) {
  const channel = await one<{ company_id: string; queue_id: string; secret_encrypted: string; is_active: number }>(
    'SELECT company_id, queue_id, secret_encrypted, is_active FROM service_inbound_email WHERE endpoint_key = $1', [endpointKey]);
  // Same refusal for an unknown key, a disabled channel and a bad signature.
  if (!channel || !channel.is_active || !signature || !timestamp) throw unauthenticated('Invalid signature');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) throw unauthenticated('Invalid signature');
  const expected = hmacSignature(decryptField(channel.secret_encrypted), `${timestamp}.${rawBody}`);
  if (!safeEqual(expected, signature.replace(/^sha256=/, ''))) throw unauthenticated('Invalid signature');

  let message: InboundMessage;
  try {
    const parsed = JSON.parse(rawBody) as Partial<InboundMessage>;
    if (!parsed.messageId || !parsed.from || typeof parsed.text !== 'string') throw new Error('shape');
    message = { messageId: String(parsed.messageId).slice(0, 300), from: String(parsed.from), subject: String(parsed.subject ?? '').slice(0, 300), text: parsed.text };
  } catch {
    throw unprocessable('Expected JSON with messageId, from, subject and text');
  }

  const companyId = channel.company_id;
  await pool.query('UPDATE service_inbound_email SET last_received_at = NOW(3) WHERE company_id = $1', [companyId]);
  const address = senderAddress(message.from);
  const record = async (outcome: string, ticketId: string | null, detail: string | null) => {
    await pool.query(
      `INSERT INTO service_inbound_messages (id, company_id, message_id, from_address, subject, outcome, ticket_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), companyId, message.messageId, address.slice(0, 320), message.subject || null, outcome, ticketId, detail],
    );
    return { outcome, ticketId };
  };

  if (await one('SELECT 1 FROM service_inbound_messages WHERE company_id = $1 AND message_id = $2', [companyId, message.messageId])) {
    return { outcome: 'duplicate', ticketId: null };
  }

  const identity = await import('./identity.js');
  const user = await one<{ id: string }>("SELECT id FROM users WHERE company_id = $1 AND email = $2 AND status = 'active'", [companyId, address]);
  if (!user) return record('rejected_sender', null, 'Sender is not a person in this workspace');
  const row = await identity.findUserById(user.id);
  const actor = await identity.buildActor(row!, null);

  const service = await import('./service.js');
  const body = stripQuoted(message.text) || message.text.trim();
  const ref = message.subject.match(/\[SD-(\d+)\]/i);
  if (ref) {
    const ticket = await one<{ id: string; status: string }>('SELECT id, status FROM tickets WHERE company_id = $1 AND number = $2', [companyId, Number(ref[1])]);
    if (ticket) {
      if (ticket.status === 'closed') return record('rejected_closed', ticket.id, 'Ticket is closed');
      try {
        await service.addComment(actor, ticket.id, { body: body.slice(0, 20000) || '(empty message)', visibility: 'public' });
        return record('replied', ticket.id, null);
      } catch (err) {
        // Not allowed to reply to that ticket: fall through and open a new one rather
        // than leaking whether the referenced ticket exists.
        logger.info({ err, companyId }, 'inbound email reply refused; opening a new ticket');
      }
    }
  }

  const subject = message.subject.replace(/^(re|fwd?):\s*/i, '').trim() || '(no subject)';
  const queue = await one<{ audience: string }>('SELECT audience FROM service_queues WHERE id = $1', [channel.queue_id]);
  let clientOrgId: string | null = null;
  if (actor.accessLevel === 'guest') {
    const membership = await one<{ organization_id: string }>('SELECT organization_id FROM external_memberships WHERE user_id = $1 AND company_id = $2 LIMIT 1', [actor.userId, companyId]);
    clientOrgId = membership?.organization_id ?? null;
  } else if (!actor.capabilities.has('ticket.create')) {
    return record('rejected_sender', null, 'Sender cannot raise tickets');
  }
  const ticket = await service.insertTicket(actor, {
    subject: subject.length < 3 ? `${subject} (email)` : subject,
    description: body.slice(0, 20000) || '(empty message)',
    type: 'request', priority: 'normal', queueId: channel.queue_id, categoryId: null,
    requesterId: actor.userId, clientOrgId, channel: 'email',
  });
  if (queue?.audience === 'client' && actor.accessLevel !== 'guest') {
    logger.info({ companyId, ticketId: ticket.id }, 'employee email landed in a client queue');
  }
  return record('created', ticket.id, null);
}

/** Only used by tests and the settings screen's self-check. */
export function sign(secret: string, timestamp: string, body: string): string {
  return hmacSignature(secret, `${timestamp}.${body}`);
}
