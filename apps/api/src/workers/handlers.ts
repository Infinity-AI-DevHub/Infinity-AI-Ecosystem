/**
 * Event handlers (blueprint 06).
 *
 * Each handler reacts to a committed domain event: provisioning mailboxes, delivering
 * mail through the provider, fanning out notifications, and keeping the search index
 * current. Every handler is written to be safely repeatable.
 */
import { many, one, pool } from '../core/db.js';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import type { StoredEvent } from '../core/outbox.js';
import { mailDriver } from '../adapters/mail.js';
import * as mail from '../domains/mail.js';
import * as notifications from '../domains/notifications.js';
import * as searchIndex from '../domains/search.js';
import * as tasks from '../domains/tasks.js';
import * as files from '../domains/files.js';
import { publish, publishToUser } from '../core/realtime.js';

type Handler = (event: StoredEvent) => Promise<void>;

const publicUrl = config.publicUrl;

// ----------------------------------------------------------------- identity

/**
 * A new employee needs a mailbox and an activation email. Provisioning is asynchronous
 * because the provider may be slow or briefly unavailable; the administrator sees
 * "pending" until it reports ready.
 */
const onUserInvited: Handler = async (event) => {
  const { userId, email, displayName, invitationToken } = event.payload as {
    userId: string;
    email: string;
    displayName: string;
    invitationToken?: string;
  };

  const mailbox = await mail.ensureMailbox(event.company_id, userId, email, displayName);

  if (mailbox.provision_state === 'pending') {
    await pool.query(`UPDATE mailboxes SET provision_state = 'provisioning' WHERE id = $1`, [mailbox.id]);
    try {
      const provisioned = await mailDriver.provisionMailbox(email, displayName);
      await pool.query(
        `UPDATE mailboxes SET provider_id = $2, provision_state = 'ready', updated_at = now() WHERE id = $1`,
        [mailbox.id, provisioned.providerId],
      );
    } catch (err) {
      await pool.query(
        `UPDATE mailboxes SET provision_state = 'failed', updated_at = now() WHERE id = $1`,
        [mailbox.id],
      );
      // Rethrow so the event retries with backoff rather than silently leaving a
      // half-provisioned account.
      throw err;
    }
  }

  if (invitationToken) {
    const activationUrl = `${publicUrl}/activate?token=${invitationToken}`;
    await mailDriver.send({
      from: { address: `no-reply@${config.mail.defaultDomain}`, name: 'Infinity Workspace' },
      to: [email],
      subject: 'Activate your Infinity Workspace account',
      text: [
        `Hello ${displayName},`,
        '',
        'An account has been created for you in Infinity Workspace.',
        'Use the link below to set your password and enrol your authenticator app.',
        '',
        activationUrl,
        '',
        `This link expires in ${config.security.invitationTtlHours} hours and can be used once.`,
        'If you were not expecting this, contact your administrator.',
      ].join('\n'),
    });
  }

  await searchIndex.index({
    companyId: event.company_id,
    docType: 'person',
    resourceId: userId,
    title: displayName,
    body: `${displayName} ${email}`,
    aclCompanyWide: true,
    link: `/people/${userId}`,
  });
};

const onUserActivated: Handler = async (event) => {
  const { userId } = event.payload as { userId: string };
  await pool.query(
    `UPDATE mailboxes SET provision_state = 'ready', updated_at = now()
      WHERE owner_id = $1 AND provision_state IN ('pending','provisioning')`,
    [userId],
  );
  await notifications.create({
    companyId: event.company_id,
    userId,
    type: 'welcome',
    title: 'Welcome to Infinity Workspace',
    body: 'Your account is active. Review your profile and notification preferences to get started.',
    link: '/command',
    dedupeKey: `welcome:${userId}`,
  });
};

/**
 * A suspension or role change must not leave stale access anywhere: sockets are closed
 * by the domain, and here the search ACLs are corrected urgently rather than on the
 * next scheduled rebuild.
 */
const onAccessChanged: Handler = async (event) => {
  const { userId } = event.payload as { userId: string; accessLevelChanged?: boolean };
  await searchIndex.reindexForUserAccessChange(userId);
};

// ----------------------------------------------------------------- mail

/**
 * Delivery. The message row was committed before this ran, so a provider failure
 * degrades to a retry and a visible failed state - never a lost message.
 */
const onMailQueued: Handler = async (event) => {
  const { messageId } = event.payload as { messageId: string };

  const message = await one<{
    id: string;
    from_address: string;
    from_name: string | null;
    to_addresses: string[];
    cc_addresses: string[];
    bcc_addresses: string[];
    subject: string;
    body_text: string;
    body_html_sanitized: string | null;
    in_reply_to: string | null;
    delivery_state: string;
  }>(
    `SELECT id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, subject,
            body_text, body_html_sanitized, in_reply_to, delivery_state
       FROM mail_messages WHERE id = $1`,
    [messageId],
  );
  if (!message) return;
  // Idempotency: a redelivered event must not send the message twice.
  if (message.delivery_state !== 'queued') return;

  await pool.query(`UPDATE mail_messages SET delivery_state = 'sending' WHERE id = $1`, [messageId]);

  const attachments = await many<{ filename: string; mime_type: string; object_key: string }>(
    'SELECT filename, mime_type, object_key FROM mail_attachments WHERE message_id = $1',
    [messageId],
  );

  try {
    const loaded = [];
    for (const attachment of attachments) {
      const stream = await files.readStream(attachment.object_key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      loaded.push({
        filename: attachment.filename,
        mimeType: attachment.mime_type,
        content: Buffer.concat(chunks),
      });
    }

    const result = await mailDriver.send({
      from: { address: message.from_address, name: message.from_name ?? undefined },
      to: message.to_addresses,
      cc: message.cc_addresses,
      bcc: message.bcc_addresses,
      subject: message.subject,
      text: message.body_text,
      html: message.body_html_sanitized ?? undefined,
      inReplyTo: message.in_reply_to,
      attachments: loaded,
    });

    await mail.markDelivery(
      messageId,
      'sent',
      result.rejected.length > 0 ? `Rejected: ${result.rejected.join(', ')}` : null,
      result.providerMessageId,
    );
    await mail.indexMessage(messageId);
  } catch (err) {
    // Return to 'queued' so the retry is picked up cleanly, and surface the reason.
    const detail = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE mail_messages SET delivery_state = 'queued', delivery_detail = $2, updated_at = now()
        WHERE id = $1`,
      [messageId, detail.slice(0, 500)],
    );
    throw err;
  }
};

const onMailReceived: Handler = async (event) => {
  const { messageId, ownerId, quarantined } = event.payload as {
    messageId: string;
    ownerId: string | null;
    quarantined?: boolean;
  };
  await mail.indexMessage(messageId);
  if (!ownerId) return;

  const message = await one<{ subject: string; from_address: string }>(
    'SELECT subject, from_address FROM mail_messages WHERE id = $1',
    [messageId],
  );
  await notifications.create({
    companyId: event.company_id,
    userId: ownerId,
    type: quarantined ? 'mail.quarantined' : 'mail.received',
    title: quarantined ? 'A message was quarantined' : `New message from ${message?.from_address ?? 'a sender'}`,
    body: message?.subject ?? '',
    link: `/mail/${messageId}`,
    resourceType: 'mail_message',
    resourceId: messageId,
    dedupeKey: `mail:${messageId}`,
  });
};

// ----------------------------------------------------------------- calendar

const onEventScheduled: Handler = async (event) => {
  const { eventId, attendeeIds, organizerId } = event.payload as {
    eventId: string;
    attendeeIds: string[];
    organizerId: string;
  };
  const meeting = await one<{ title: string; starts_at: Date; company_id: string; description: string }>(
    'SELECT title, starts_at, company_id, description FROM calendar_events WHERE id = $1',
    [eventId],
  );
  if (!meeting) return;

  await notifications.createMany(
    attendeeIds,
    (userId) => ({
      companyId: event.company_id,
      userId,
      type: 'meeting.invited',
      title: `Meeting invitation: ${meeting.title}`,
      body: new Date(meeting.starts_at).toISOString(),
      link: `/meetings/${eventId}`,
      resourceType: 'calendar_event',
      resourceId: eventId,
      dedupeKey: `meeting-invite:${eventId}:${userId}`,
    }),
    organizerId,
  );

  await searchIndex.index({
    companyId: event.company_id,
    docType: 'meeting',
    resourceId: eventId,
    title: meeting.title,
    body: meeting.description,
    aclUserIds: attendeeIds,
    link: `/meetings/${eventId}`,
  });
};

const onEventChanged: Handler = async (event) => {
  const { eventId, timeChanged, title } = event.payload as {
    eventId: string;
    timeChanged?: boolean;
    title?: string;
  };
  const attendees = await many<{ user_id: string }>(
    'SELECT user_id FROM event_attendees WHERE event_id = $1',
    [eventId],
  );
  const cancelled = event.type === 'event.cancelled';
  await notifications.createMany(
    attendees.map((a) => a.user_id),
    (userId) => ({
      companyId: event.company_id,
      userId,
      type: cancelled ? 'meeting.cancelled' : 'meeting.updated',
      title: cancelled ? `Meeting cancelled: ${title ?? ''}` : 'A meeting you are attending changed',
      link: cancelled ? '/meetings' : `/meetings/${eventId}`,
      resourceType: 'calendar_event',
      resourceId: eventId,
      dedupeKey: `meeting-${event.type}:${eventId}:${userId}:${event.id}`,
    }),
    event.actor_id,
  );
  if (cancelled) await searchIndex.remove('meeting', eventId);
  // A time change invalidates any reminder already scheduled for the old slot.
  if (timeChanged) {
    await pool.query(
      `DELETE FROM notifications WHERE resource_id = $1 AND type = 'meeting.reminder' AND read_at IS NULL`,
      [eventId],
    );
  }
};

// ----------------------------------------------------------------- chat

const onChatMessage: Handler = async (event) => {
  const { roomId, messageId, mentions } = event.payload as {
    roomId: string;
    messageId: string;
    mentions: string[];
  };
  const message = await one<{ body: string; author_id: string | null; company_id: string }>(
    'SELECT body, author_id, company_id FROM chat_messages WHERE id = $1',
    [messageId],
  );
  if (!message) return;

  const room = await one<{ name: string | null; type: string }>(
    'SELECT name, type FROM chat_rooms WHERE id = $1',
    [roomId],
  );
  const author = message.author_id
    ? await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [message.author_id])
    : null;

  await searchIndex.index({
    companyId: event.company_id,
    docType: 'chat',
    resourceId: messageId,
    title: room?.name ? `#${room.name}` : 'Direct message',
    body: message.body,
    classification: 'confidential',
    aclUserIds: (
      await many<{ user_id: string }>('SELECT user_id FROM chat_members WHERE room_id = $1', [roomId])
    ).map((m) => m.user_id),
    link: `/chat/${roomId}`,
  });

  // Direct messages notify every other participant; channels notify only on mention.
  const recipients =
    room?.type === 'direct'
      ? (await many<{ user_id: string }>('SELECT user_id FROM chat_members WHERE room_id = $1', [roomId])).map(
          (m) => m.user_id,
        )
      : mentions;

  await notifications.createMany(
    recipients,
    (userId) => ({
      companyId: event.company_id,
      userId,
      type: room?.type === 'direct' ? 'chat.direct' : 'chat.mention',
      title:
        room?.type === 'direct'
          ? `${author?.display_name ?? 'Someone'} sent you a message`
          : `${author?.display_name ?? 'Someone'} mentioned you in #${room?.name ?? ''}`,
      body: message.body.slice(0, 140),
      link: `/chat/${roomId}`,
      resourceType: 'chat_room',
      resourceId: roomId,
      dedupeKey: `chat:${messageId}:${userId}`,
    }),
    message.author_id,
  );
};

// ----------------------------------------------------------------- tasks

const onTaskEvent: Handler = async (event) => {
  const { taskId, assigneeId, title } = event.payload as {
    taskId: string;
    assigneeId?: string | null;
    title?: string;
  };
  await tasks.indexTask(taskId);

  if (event.type === 'task.assigned' && assigneeId && assigneeId !== event.actor_id) {
    await notifications.create({
      companyId: event.company_id,
      userId: assigneeId,
      type: 'task.assigned',
      title: 'A task was assigned to you',
      body: title ?? '',
      link: `/tasks/${taskId}`,
      resourceType: 'task',
      resourceId: taskId,
      dedupeKey: `task-assign:${taskId}:${assigneeId}:${event.id}`,
    });
  }
};

// ----------------------------------------------------------------- files

const onFileEvent: Handler = async (event) => {
  const { fileId, scanState } = event.payload as { fileId: string; scanState?: string };
  await files.indexFile(fileId);

  if (scanState === 'infected') {
    const file = await one<{ owner_id: string | null; name: string }>(
      'SELECT owner_id, name FROM files WHERE id = $1',
      [fileId],
    );
    if (file?.owner_id) {
      await notifications.create({
        companyId: event.company_id,
        userId: file.owner_id,
        type: 'file.quarantined',
        title: 'A file you uploaded was quarantined',
        body: file.name,
        link: `/files`,
        resourceType: 'file',
        resourceId: fileId,
        dedupeKey: `file-quarantine:${fileId}`,
      });
    }
  }
};

// ----------------------------------------------------------------- approvals

const onApprovalRequested: Handler = async (event) => {
  const { requestId, reference, approverIds, title } = event.payload as {
    requestId: string;
    reference: string;
    approverIds: string[];
    title: string;
  };
  await notifications.createMany(approverIds, (userId) => ({
    companyId: event.company_id,
    userId,
    type: 'approval.awaiting',
    title: `Approval needed: ${reference}`,
    body: title,
    link: `/approvals/${requestId}`,
    resourceType: 'approval_request',
    resourceId: requestId,
    dedupeKey: `approval-await:${requestId}:${userId}`,
  }));
};

const onApprovalProgressed: Handler = async (event) => {
  const { requestId, reference, decision, status, requesterId, nextStep } = event.payload as {
    requestId: string;
    reference: string;
    decision?: string;
    status?: string;
    requesterId?: string;
    nextStep?: number | null;
  };

  if (requesterId) {
    await notifications.create({
      companyId: event.company_id,
      userId: requesterId,
      type: 'approval.progress',
      title: `${reference} was ${decision ?? status ?? 'updated'}`,
      link: `/approvals/${requestId}`,
      resourceType: 'approval_request',
      resourceId: requestId,
      dedupeKey: `approval-progress:${requestId}:${event.id}`,
    });
  }

  // A sequential route hands the request to the next approver in line.
  if (status === 'pending' && nextStep) {
    const nextApprovers = await many<{ approver_id: string }>(
      `SELECT approver_id FROM approval_steps
        WHERE request_id = $1 AND step_number = $2 AND state = 'active'`,
      [requestId, nextStep],
    );
    await notifications.createMany(
      nextApprovers.map((a) => a.approver_id),
      (userId) => ({
        companyId: event.company_id,
        userId,
        type: 'approval.awaiting',
        title: `Approval needed: ${reference}`,
        link: `/approvals/${requestId}`,
        resourceType: 'approval_request',
        resourceId: requestId,
        dedupeKey: `approval-await:${requestId}:${userId}:${nextStep}`,
      }),
    );
  }
};

// ----------------------------------------------------------------- announcements

const onAnnouncementPublished: Handler = async (event) => {
  const { announcementId, title, audience } = event.payload as {
    announcementId: string;
    title: string;
    audience: { scope: string; departmentIds?: string[]; groupIds?: string[] };
  };

  let recipients: { id: string }[] = [];
  if (audience.scope === 'company') {
    recipients = await many<{ id: string }>(
      `SELECT id FROM users WHERE company_id = $1 AND status = 'active'`,
      [event.company_id],
    );
  } else if (audience.scope === 'department') {
    recipients = await many<{ id: string }>(
      `SELECT id FROM users WHERE company_id = $1 AND status = 'active' AND department_id = ANY($2::uuid[])`,
      [event.company_id, audience.departmentIds ?? []],
    );
  } else if (audience.scope === 'group') {
    recipients = await many<{ id: string }>(
      `SELECT DISTINCT u.id FROM users u
         JOIN group_members gm ON gm.user_id = u.id
        WHERE u.company_id = $1 AND u.status = 'active' AND gm.group_id = ANY($2::uuid[])`,
      [event.company_id, audience.groupIds ?? []],
    );
  }

  await notifications.createMany(
    recipients.map((r) => r.id),
    (userId) => ({
      companyId: event.company_id,
      userId,
      type: 'announcement',
      title,
      link: `/announcements/${announcementId}`,
      resourceType: 'announcement',
      resourceId: announcementId,
      dedupeKey: `announcement:${announcementId}:${userId}`,
    }),
    event.actor_id,
  );
};

// ----------------------------------------------------------------- registry

export const handlers: Record<string, Handler> = {
  'user.invited': onUserInvited,
  'user.activated': onUserActivated,
  'user.updated': onAccessChanged,
  'user.suspended': onAccessChanged,
  'user.reactivated': onAccessChanged,
  'mail.queued': onMailQueued,
  'mail.received': onMailReceived,
  'event.scheduled': onEventScheduled,
  'event.updated': onEventChanged,
  'event.cancelled': onEventChanged,
  'chat.message.created': onChatMessage,
  'task.created': onTaskEvent,
  'task.updated': onTaskEvent,
  'task.assigned': onTaskEvent,
  'file.created': onFileEvent,
  'file.versioned': onFileEvent,
  'file.recycled': onFileEvent,
  'approval.requested': onApprovalRequested,
  'approval.decided': onApprovalProgressed,
  'approval.completed': onApprovalProgressed,
  'announcement.published': onAnnouncementPublished,
};

export { logger, publish, publishToUser };
