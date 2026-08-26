/**
 * Mail domain (blueprint 09).
 *
 * Owns mailboxes, messages, MIME metadata, folders, drafts and delivery state.
 * It does not own binary attachment storage (files/object storage) or employee master
 * data (identity). Internet delivery belongs to the provider adapter.
 */
import { many, one, pool, transaction, type Queryable } from '../core/db.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { decodeCursor, encodeCursor, isDangerousAttachment, safeFilename } from '../core/validation.js';
import { htmlToText, sanitizeEmailHtml, snippet } from '../core/sanitize.js';
import { assertNoHeaderInjection } from '../adapters/mail.js';
import { config } from '../core/config.js';
import * as searchIndex from './search.js';

export type MailboxRow = {
  id: string;
  company_id: string;
  owner_id: string | null;
  address: string;
  display_name: string;
  type: string;
  provider_id: string | null;
  provision_state: string;
  quota_bytes: number;
  used_bytes: number;
};

export type MessageRow = {
  id: string;
  company_id: string;
  mailbox_id: string;
  folder_id: string;
  thread_id: string | null;
  direction: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  body_text: string;
  body_html_sanitized: string | null;
  snippet: string;
  is_read: boolean;
  is_flagged: boolean;
  is_draft: boolean;
  labels: string[];
  delivery_state: string;
  delivery_detail: string | null;
  scan_state: string;
  size_bytes: number;
  version: number;
  sent_at: Date | null;
  received_at: Date;
};

const SYSTEM_FOLDERS: { name: string; kind: string; position: number }[] = [
  { name: 'Inbox', kind: 'inbox', position: 1 },
  { name: 'Sent', kind: 'sent', position: 2 },
  { name: 'Drafts', kind: 'drafts', position: 3 },
  { name: 'Archive', kind: 'archive', position: 4 },
  { name: 'Spam', kind: 'spam', position: 5 },
  { name: 'Trash', kind: 'trash', position: 6 },
  { name: 'Quarantine', kind: 'quarantine', position: 7 },
];

/** Creates the mailbox record and its system folders. Provider provisioning is async. */
export async function ensureMailbox(
  companyId: string,
  ownerId: string,
  address: string,
  displayName: string,
  db: Queryable = pool,
): Promise<MailboxRow> {
  const existing = await db.query<MailboxRow>(
    'SELECT * FROM mailboxes WHERE company_id = $1 AND address = $2',
    [companyId, address],
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await db.query<MailboxRow>(
    `INSERT INTO mailboxes (company_id, owner_id, address, display_name, type, provision_state)
     VALUES ($1,$2,$3,$4,'user','pending') RETURNING *`,
    [companyId, ownerId, address, displayName],
  );
  const mailbox = created.rows[0]!;
  for (const folder of SYSTEM_FOLDERS) {
    await db.query(
      `INSERT INTO mail_folders (company_id, mailbox_id, name, kind, position)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [companyId, mailbox.id, folder.name, folder.kind, folder.position],
    );
  }
  return mailbox;
}

/**
 * Resolves which mailbox the actor may act on. Ownership or an explicit delegation is
 * required; an administrator reaching another mailbox is recorded in the audit trail.
 */
export async function resolveMailbox(
  actor: Actor,
  mailboxId?: string,
  need: 'read' | 'send' | 'full' = 'read',
): Promise<MailboxRow> {
  const mailbox = mailboxId
    ? await one<MailboxRow>('SELECT * FROM mailboxes WHERE id = $1 AND company_id = $2', [
        mailboxId,
        actor.companyId,
      ])
    : await one<MailboxRow>(
        `SELECT * FROM mailboxes WHERE company_id = $1 AND owner_id = $2 AND type = 'user' LIMIT 1`,
        [actor.companyId, actor.userId],
      );
  if (!mailbox) throw notFound('Mailbox not found');
  if (mailbox.owner_id === actor.userId) return mailbox;

  const delegation = await one<{ access: string }>(
    'SELECT access FROM mailbox_delegates WHERE mailbox_id = $1 AND user_id = $2',
    [mailbox.id, actor.userId],
  );
  const rank: Record<string, number> = { read: 1, send: 2, full: 3 };
  if (delegation && (rank[delegation.access] ?? 0) >= (rank[need] ?? 3)) return mailbox;

  await authorize({
    actor,
    capability: need === 'read' ? 'mail.read' : 'mail.send',
    resourceType: 'mailbox',
    resourceId: mailbox.id,
    membership: false,
  });
  return mailbox;
}

export async function listFolders(mailboxId: string) {
  return many<{ id: string; name: string; kind: string; unread: number; total: number }>(
    `SELECT f.id, f.name, f.kind,
            count(m.id) FILTER (WHERE m.is_read = false)::int AS unread,
            count(m.id)::int AS total
       FROM mail_folders f
       LEFT JOIN mail_messages m ON m.folder_id = f.id
      WHERE f.mailbox_id = $1
      GROUP BY f.id
      ORDER BY f.position, f.name`,
    [mailboxId],
  );
}

export async function listMessages(
  mailbox: MailboxRow,
  opts: { folderId?: string; folderKind?: string; unreadOnly?: boolean; limit: number; cursor?: string },
) {
  const cursor = decodeCursor(opts.cursor);
  const rows = await many<MessageRow & { total: number }>(
    `SELECT m.*, count(*) OVER () AS total
       FROM mail_messages m
       JOIN mail_folders f ON f.id = m.folder_id
      WHERE m.mailbox_id = $1
        AND ($2::uuid IS NULL OR m.folder_id = $2)
        AND ($3::text IS NULL OR f.kind = $3)
        AND ($4::boolean IS NOT TRUE OR m.is_read = false)
        AND ($5::timestamptz IS NULL OR (m.received_at, m.id) < ($5, $6::uuid))
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT $7`,
    [
      mailbox.id,
      opts.folderId ?? null,
      opts.folderKind ?? null,
      opts.unreadOnly ?? false,
      cursor?.at ?? null,
      cursor?.id ?? null,
      opts.limit + 1,
    ],
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(publicMessage),
    total: rows[0]?.total ?? 0,
    nextCursor: hasMore && last ? encodeCursor({ at: last.received_at, id: last.id }) : null,
  };
}

export async function getMessage(mailbox: MailboxRow, messageId: string) {
  const message = await one<MessageRow>(
    'SELECT * FROM mail_messages WHERE id = $1 AND mailbox_id = $2',
    [messageId, mailbox.id],
  );
  if (!message) throw notFound('Message not found');
  const attachments = await many(
    `SELECT id, filename, mime_type, size_bytes, scan_state FROM mail_attachments WHERE message_id = $1`,
    [messageId],
  );
  return { ...publicMessage(message), attachments, bodyHtml: message.body_html_sanitized };
}

export type ComposeInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string | null;
  attachmentFileIds?: string[];
  saveAsDraft?: boolean;
};

/**
 * Persists an outbound message and queues it for delivery. The message row is committed
 * before any provider call so a provider timeout can never lose the user's mail.
 */
export async function compose(
  actor: Actor,
  mailbox: MailboxRow,
  input: ComposeInput,
  correlationId: string,
): Promise<MessageRow> {
  if (mailbox.provision_state === 'disabled') {
    throw forbidden('Outbound mail is disabled for this mailbox');
  }
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
  if (!input.saveAsDraft && recipients.length === 0) {
    throw unprocessable('At least one recipient is required', [
      { field: 'to', message: 'Add a recipient' },
    ]);
  }
  if (recipients.length > 200) {
    throw unprocessable('Too many recipients in a single message', [
      { field: 'to', message: 'Maximum 200 recipients' },
    ]);
  }
  // Header injection is malformed input from the client, not a server fault: it must
  // surface as a field-level validation error rather than a 500.
  for (const address of recipients) {
    if (/[\r\n]/.test(address)) {
      throw unprocessable('Recipient address is not valid', [
        { field: 'to', message: 'An address must not contain line breaks' },
      ]);
    }
  }
  if (/[\r\n]/.test(input.subject)) {
    throw unprocessable('Subject is not valid', [
      { field: 'subject', message: 'The subject must not contain line breaks' },
    ]);
  }
  // Defence in depth: the adapter re-checks before anything reaches the wire.
  for (const address of recipients) assertNoHeaderInjection(address, 'recipient');
  assertNoHeaderInjection(input.subject, 'subject');

  const sanitizedHtml = input.bodyHtml ? sanitizeEmailHtml(input.bodyHtml, false) : null;
  const bodyText = input.bodyText || (sanitizedHtml ? htmlToText(sanitizedHtml) : '');
  const isDraft = input.saveAsDraft === true;

  return transaction(async (tx) => {
    const folder = await folderByKind(tx, mailbox.id, isDraft ? 'drafts' : 'sent');
    const res = await tx.query<MessageRow>(
      `INSERT INTO mail_messages
         (company_id, mailbox_id, folder_id, direction, from_address, from_name,
          to_addresses, cc_addresses, bcc_addresses, subject, body_text,
          body_html_sanitized, snippet, size_bytes, is_read, is_draft, delivery_state, in_reply_to, sent_at)
       VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$17)
       RETURNING *`,
      [
        actor.companyId,
        mailbox.id,
        folder.id,
        mailbox.address,
        actor.displayName,
        input.to,
        input.cc ?? [],
        input.bcc ?? [],
        input.subject,
        bodyText,
        sanitizedHtml,
        snippet(bodyText),
        Buffer.byteLength(bodyText) + Buffer.byteLength(sanitizedHtml ?? ''),
        isDraft,
        isDraft ? 'draft' : 'queued',
        input.inReplyTo ?? null,
        isDraft ? null : new Date(),
      ],
    );
    const message = res.rows[0]!;

    for (const fileId of input.attachmentFileIds ?? []) {
      const file = await tx.query<{
        id: string;
        name: string;
        mime_type: string;
        size_bytes: number;
        state: string;
        owner_id: string | null;
      }>(
        `SELECT f.id, f.name, f.mime_type, f.size_bytes, f.state, f.owner_id
           FROM files f WHERE f.id = $1 AND f.company_id = $2`,
        [fileId, actor.companyId],
      );
      const row = file.rows[0];
      if (!row) throw notFound('Attachment not found');
      if (row.state !== 'active') throw conflict('Attachment is still being processed or is quarantined');
      if (isDangerousAttachment(row.name)) {
        throw unprocessable('This file type cannot be attached', [
          { field: 'attachmentFileIds', message: `${row.name} is a blocked attachment type` },
        ]);
      }
      const version = await tx.query<{ object_key: string; checksum: string }>(
        `SELECT object_key, checksum FROM file_versions
          WHERE file_id = $1 ORDER BY version DESC LIMIT 1`,
        [fileId],
      );
      await tx.query(
        `INSERT INTO mail_attachments
           (company_id, message_id, filename, mime_type, size_bytes, object_key, checksum, scan_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'clean')`,
        [
          actor.companyId,
          message.id,
          safeFilename(row.name),
          row.mime_type,
          row.size_bytes,
          version.rows[0]?.object_key ?? '',
          version.rows[0]?.checksum ?? null,
        ],
      );
    }

    await auditFromActor(
      actor,
      isDraft ? 'mail.draft_saved' : 'mail.send',
      {
        resourceType: 'mail_message',
        resourceId: message.id,
        correlationId,
        // Recipients and subject are business metadata; bodies are never audited.
        metadata: { recipientCount: recipients.length, mailboxId: mailbox.id },
      },
      tx,
    );

    if (!isDraft) {
      await emit(
        {
          companyId: actor.companyId,
          type: 'mail.queued',
          actorId: actor.userId,
          correlationId,
          payload: { messageId: message.id, mailboxId: mailbox.id },
        },
        tx,
      );
    }
    return message;
  });
}

/**
 * Resolves a system folder, creating it if it is absent.
 *
 * The system folder set is an invariant of every mailbox, but provisioning can fail
 * part-way through and mailboxes may also arrive from migration or direct provider
 * sync. Self-healing here keeps a partially provisioned mailbox usable instead of
 * failing the user's send with a confusing error.
 */
async function folderByKind(db: Queryable, mailboxId: string, kind: string) {
  const res = await db.query<{ id: string }>(
    'SELECT id FROM mail_folders WHERE mailbox_id = $1 AND kind = $2 LIMIT 1',
    [mailboxId, kind],
  );
  const folder = res.rows[0];
  if (folder) return folder;

  const definition = SYSTEM_FOLDERS.find((f) => f.kind === kind);
  if (!definition) throw notFound(`Unknown mail folder: ${kind}`);

  const mailbox = await db.query<{ company_id: string }>(
    'SELECT company_id FROM mailboxes WHERE id = $1',
    [mailboxId],
  );
  const companyId = mailbox.rows[0]?.company_id;
  if (!companyId) throw notFound('Mailbox not found');

  const created = await db.query<{ id: string }>(
    `INSERT INTO mail_folders (company_id, mailbox_id, name, kind, position)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (mailbox_id, name) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`,
    [companyId, mailboxId, definition.name, definition.kind, definition.position],
  );
  const row = created.rows[0];
  if (!row) throw notFound(`Mailbox is missing its ${kind} folder`);
  return row;
}

export async function updateFlags(
  actor: Actor,
  mailbox: MailboxRow,
  messageId: string,
  changes: { isRead?: boolean; isFlagged?: boolean; labels?: string[] },
  expectedVersion: number | null,
): Promise<MessageRow> {
  const existing = await one<MessageRow>(
    'SELECT * FROM mail_messages WHERE id = $1 AND mailbox_id = $2',
    [messageId, mailbox.id],
  );
  if (!existing) throw notFound('Message not found');
  if (expectedVersion !== null && existing.version !== expectedVersion) {
    throw preconditionFailed();
  }
  const res = await pool.query<MessageRow>(
    `UPDATE mail_messages SET
       is_read = COALESCE($3, is_read),
       is_flagged = COALESCE($4, is_flagged),
       labels = COALESCE($5, labels),
       version = version + 1,
       updated_at = now()
     WHERE id = $1 AND mailbox_id = $2 RETURNING *`,
    [messageId, mailbox.id, changes.isRead ?? null, changes.isFlagged ?? null, changes.labels ?? null],
  );
  return res.rows[0]!;
}

export async function moveMessage(
  actor: Actor,
  mailbox: MailboxRow,
  messageId: string,
  targetFolderKind: string,
): Promise<MessageRow> {
  const folder = await folderByKind(pool, mailbox.id, targetFolderKind);
  const res = await pool.query<MessageRow>(
    `UPDATE mail_messages SET folder_id = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND mailbox_id = $2 RETURNING *`,
    [messageId, mailbox.id, folder.id],
  );
  const message = res.rows[0];
  if (!message) throw notFound('Message not found');
  await auditFromActor(actor, 'mail.move', {
    resourceType: 'mail_message',
    resourceId: messageId,
    metadata: { to: targetFolderKind },
  });
  return message;
}

/**
 * Inbound ingestion from a provider webhook or IMAP sync.
 * Deduplicated by provider message ID; HTML is sanitized; dangerous attachments are
 * quarantined rather than delivered.
 */
export type InboundMessage = {
  companyId: string;
  toAddress: string;
  fromAddress: string;
  fromName?: string;
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  providerMessageId: string;
  messageIdHeader?: string;
  inReplyTo?: string;
  receivedAt?: Date;
  attachments?: { filename: string; mimeType: string; sizeBytes: number; objectKey: string }[];
};

export async function ingestInbound(input: InboundMessage): Promise<{ messageId: string | null; deduplicated: boolean }> {
  const mailbox = await one<MailboxRow>(
    'SELECT * FROM mailboxes WHERE company_id = $1 AND address = $2',
    [input.companyId, input.toAddress.toLowerCase()],
  );
  if (!mailbox) throw notFound('Recipient mailbox not found');

  const sanitizedHtml = input.html ? sanitizeEmailHtml(input.html, true) : null;
  const bodyText = input.text || (sanitizedHtml ? htmlToText(sanitizedHtml) : '');
  const hasDangerousAttachment = (input.attachments ?? []).some((a) => isDangerousAttachment(a.filename));

  return transaction(async (tx) => {
    const folder = await folderByKind(tx, mailbox.id, hasDangerousAttachment ? 'quarantine' : 'inbox');
    const res = await tx.query<MessageRow>(
      `INSERT INTO mail_messages
         (company_id, mailbox_id, folder_id, direction, provider_message_id, message_id_header,
          in_reply_to, from_address, from_name, to_addresses, cc_addresses, subject,
          body_text, body_html_sanitized, snippet, size_bytes, delivery_state, scan_state, received_at)
       VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18, now()))
       ON CONFLICT (mailbox_id, provider_message_id) WHERE provider_message_id IS NOT NULL
         DO NOTHING
       RETURNING *`,
      [
        input.companyId,
        mailbox.id,
        folder.id,
        input.providerMessageId,
        input.messageIdHeader ?? null,
        input.inReplyTo ?? null,
        input.fromAddress.toLowerCase(),
        input.fromName ?? null,
        [mailbox.address],
        input.cc ?? [],
        input.subject,
        bodyText,
        sanitizedHtml,
        snippet(bodyText),
        Buffer.byteLength(bodyText),
        hasDangerousAttachment ? 'quarantined' : 'stored',
        hasDangerousAttachment ? 'infected' : 'clean',
        input.receivedAt ?? null,
      ],
    );
    const message = res.rows[0];
    if (!message) return { messageId: null, deduplicated: true };

    for (const attachment of input.attachments ?? []) {
      await tx.query(
        `INSERT INTO mail_attachments
           (company_id, message_id, filename, mime_type, size_bytes, object_key, scan_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.companyId,
          message.id,
          safeFilename(attachment.filename),
          attachment.mimeType,
          attachment.sizeBytes,
          attachment.objectKey,
          isDangerousAttachment(attachment.filename) ? 'infected' : 'pending',
        ],
      );
    }

    await emit(
      {
        companyId: input.companyId,
        type: 'mail.received',
        payload: {
          messageId: message.id,
          mailboxId: mailbox.id,
          ownerId: mailbox.owner_id,
          quarantined: hasDangerousAttachment,
        },
      },
      tx,
    );
    return { messageId: message.id, deduplicated: false };
  });
}

/** Index a message for search with the mailbox owner and delegates as the ACL. */
export async function indexMessage(messageId: string): Promise<void> {
  const row = await one<{
    id: string;
    company_id: string;
    subject: string;
    body_text: string;
    mailbox_id: string;
    owner_id: string | null;
  }>(
    `SELECT m.id, m.company_id, m.subject, m.body_text, m.mailbox_id, mb.owner_id
       FROM mail_messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.id = $1`,
    [messageId],
  );
  if (!row) return;
  const delegates = await many<{ user_id: string }>(
    'SELECT user_id FROM mailbox_delegates WHERE mailbox_id = $1',
    [row.mailbox_id],
  );
  await searchIndex.index({
    companyId: row.company_id,
    docType: 'mail',
    resourceId: row.id,
    title: row.subject || '(no subject)',
    body: row.body_text,
    classification: 'confidential',
    aclUserIds: [row.owner_id, ...delegates.map((d) => d.user_id)].filter((v): v is string => !!v),
    link: `/mail/${row.id}`,
  });
}

export async function markDelivery(
  messageId: string,
  state: 'sent' | 'delivered' | 'bounced' | 'failed',
  detail: string | null,
  providerMessageId?: string,
): Promise<void> {
  await pool.query(
    `UPDATE mail_messages
        SET delivery_state = $2, delivery_detail = $3,
            provider_message_id = COALESCE($4, provider_message_id),
            updated_at = now()
      WHERE id = $1`,
    [messageId, state, detail?.slice(0, 500) ?? null, providerMessageId ?? null],
  );
}

export function publicMessage(row: MessageRow) {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    folderId: row.folder_id,
    threadId: row.thread_id,
    direction: row.direction,
    from: { address: row.from_address, name: row.from_name },
    to: row.to_addresses,
    cc: row.cc_addresses,
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.body_text,
    isRead: row.is_read,
    isFlagged: row.is_flagged,
    isDraft: row.is_draft,
    labels: row.labels,
    deliveryState: row.delivery_state,
    deliveryDetail: row.delivery_detail,
    scanState: row.scan_state,
    sizeBytes: row.size_bytes,
    version: row.version,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
  };
}

export async function mailboxStats(mailboxId: string) {
  const row = await one<{ unread: number; total: number; quarantined: number }>(
    `SELECT count(*) FILTER (WHERE is_read = false)::int AS unread,
            count(*)::int AS total,
            count(*) FILTER (WHERE delivery_state = 'quarantined')::int AS quarantined
       FROM mail_messages WHERE mailbox_id = $1`,
    [mailboxId],
  );
  return row ?? { unread: 0, total: 0, quarantined: 0 };
}

export const defaultDomain = config.mail.defaultDomain;
