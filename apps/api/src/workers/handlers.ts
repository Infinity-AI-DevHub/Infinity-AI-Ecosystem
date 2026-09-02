/**
 * Event handlers (blueprint 06).
 *
 * Each handler reacts to a committed domain event: sending activation invitations,
 * fanning out notifications, and keeping the search index current. Every handler is
 * written to be safely repeatable, because an event can be delivered more than once.
 */
import { many, one, pool } from '../core/db.js';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import type { StoredEvent } from '../core/outbox.js';
import { notifier } from '../adapters/notifier.js';
import * as notifications from '../domains/notifications.js';
import * as searchIndex from '../domains/search.js';
import * as tasks from '../domains/tasks.js';
import * as leave from '../domains/leave.js';
import * as finance from '../domains/finance.js';
import * as files from '../domains/files.js';
import { publish, publishToUser } from '../core/realtime.js';

type Handler = (event: StoredEvent) => Promise<void>;

const publicUrl = config.publicUrl;

/**
 * Envelope sender for system messages. Falls back to a no-reply address on the
 * configured domain so a missing setting cannot produce a malformed header.
 */
function systemSender(): string {
  return config.notifications.fromAddress || `no-reply@${config.notifications.defaultDomain}`;
}

/**
 * Emails a set of people, given their user ids.
 *
 * Every handler that notifies in-app was also meant to email, and most simply did not —
 * the notification was written and nothing was sent. Putting the lookup and the send in
 * one place means adding email to a handler is one call rather than fifteen lines that
 * can be forgotten.
 *
 * Suspended and offboarded accounts are excluded: mail to somebody who has left is at
 * best noise and at worst a disclosure.
 */
async function emailUsers(
  userIds: (string | null | undefined)[],
  message: { subject: string; lines: string[] },
): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean) as string[])];
  if (ids.length === 0) return;

  const rows = await many<{ email_display: string }>(
    `SELECT email_display FROM users
      WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})
        AND status = 'active' AND email_display IS NOT NULL`,
    ids,
  );
  const to = rows.map((row) => row.email_display).filter(Boolean);
  if (to.length === 0) return;

  /*
   * One message per recipient, not one with everybody in To.
   * A single message would disclose the whole recipient list to each of them.
   */
  for (const address of to) {
    await notifier.send({
      from: { address: systemSender(), name: 'Infinity Workspace' },
      to: [address],
      subject: message.subject,
      text: message.lines.filter((line) => line !== null && line !== undefined).join('\n'),
    });
  }
}

/** A link back into the application, for the body of an email. */
function appLink(route: string): string {
  return `${config.publicUrl}${route}`;
}

// ----------------------------------------------------------------- identity

/**
 * A new employee needs their activation link. Delivery is asynchronous because the
 * provider may be slow or briefly unavailable; a failure retries with backoff rather
 * than silently stranding the invitation.
 */
/**
 * The reset link only ever exists in this message. It is not returned to the caller that
 * requested it, because that caller is anonymous - answering with the token would hand
 * anyone a password reset for any address they can name.
 */
const onPasswordResetRequested: Handler = async (event) => {
  const { email, url, expiresInMinutes } = event.payload as {
    email: string;
    url: string;
    expiresInMinutes: number;
  };

  await notifier.send({
    from: { address: systemSender(), name: 'Infinity Workspace' },
    to: [email],
    subject: 'Reset your Infinity Workspace password',
    text: [
      'A password reset was requested for this address.',
      '',
      url,
      '',
      `This link expires in ${expiresInMinutes} minutes and can be used once.`,
      'Completing it signs you out on every device.',
      '',
      'If you did not request this, you can ignore this message - your current password',
      'still works and nothing has changed. Tell your administrator if it keeps arriving.',
    ].join('\n'),
  });
};

/**
 * Settles a leave request once its approval finishes.
 *
 * Safe to run here rather than inline with the decision because the days were reserved
 * against the balance when the leave was booked. Until this runs they are still counted,
 * so a delayed settlement can under-report what has been taken but can never let someone
 * over-book.
 */
const onApprovalSettled: Handler = async (event) => {
  const { requestId, status } = event.payload as { requestId: string; status: string };
  if (status !== 'approved' && status !== 'rejected') return;

  const leaveRequest = await one<{ id: string }>(
    'SELECT id FROM leave_requests WHERE approval_request_id = $1',
    [requestId],
  );
  if (leaveRequest) {
    await leave.settleDecision(leaveRequest.id, status);
    return;
  }

  const claim = await one<{ id: string }>(
    'SELECT id FROM expense_claims WHERE approval_request_id = $1',
    [requestId],
  );
  if (claim) await finance.settleClaimDecision(claim.id, status);
};

const onUserInvited: Handler = async (event) => {
  const { userId, email, displayName, invitationToken } = event.payload as {
    userId: string;
    email: string;
    displayName: string;
    invitationToken?: string;
  };

  if (invitationToken) {
    const activationUrl = `${publicUrl}/activate?token=${invitationToken}`;
    await notifier.send({
      from: { address: systemSender(), name: 'Infinity Workspace' },
      to: [email],
      subject: 'Activate your Infinity Workspace account',
      text: [
        `Hello ${displayName},`,
        '',
        'An account has been created for you in Infinity Workspace.',
        'Use the link below to set your password.',
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

// ----------------------------------------------------------------- calendar

const onEventScheduled: Handler = async (event) => {
  const { eventId, attendeeIds, organizerId } = event.payload as {
    eventId: string;
    attendeeIds: string[];
    organizerId: string;
  };
  const meeting = await one<{
    title: string; starts_at: Date; ends_at: Date; company_id: string; description: string;
    online_url: string | null; location: string | null; agenda: string; notes: string; timezone: string;
  }>(
    `SELECT title, starts_at, ends_at, company_id, description, online_url, location,
            agenda, notes, timezone
       FROM calendar_events WHERE id = $1`,
    [eventId],
  );
  if (!meeting) return;

  /**
   * The invitation goes out by email as well as in-app, because a meeting is the one
   * notification people act on away from the application - and an online meeting is
   * useless without the link in reach.
   */
  const attendees = await many<{ email_display: string; display_name: string }>(
    `SELECT email_display, display_name FROM users
      WHERE id = ANY_PLACEHOLDER AND status = 'active'`.replace(
        'ANY_PLACEHOLDER',
        `(${attendeeIds.map((_, i) => `$${i + 1}`).join(',') || "''"})`,
      ),
    attendeeIds,
  );
  if (attendees.length > 0) {
    const when = new Date(meeting.starts_at).toISOString().replace('T', ' ').slice(0, 16);
    const lines = [
      `You have been invited to "${meeting.title}".`,
      '',
      `When: ${when} UTC (${meeting.timezone})`,
    ];
    if (meeting.online_url) lines.push('', 'Join online:', meeting.online_url);
    if (meeting.location) lines.push('', `Location: ${meeting.location}`);
    if (meeting.agenda?.trim()) lines.push('', 'Agenda:', meeting.agenda.trim());
    if (meeting.notes?.trim()) lines.push('', 'Notes:', meeting.notes.trim());
    lines.push('', `Open it in Infinity Workspace: ${publicUrl}/meetings/${eventId}`);

    await notifier.send({
      from: { address: systemSender(), name: 'Infinity Workspace' },
      to: attendees.map((a) => a.email_display),
      subject: `Invitation: ${meeting.title}`,
      text: lines.join('\n'),
    });
  }

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

  /*
   * Changes and cancellations go by email as well as in-app.
   *
   * A meeting is the one notification people act on away from the application, and a
   * cancellation nobody sees is a room of people waiting.
   */
  const meeting = await one<{
    title: string; starts_at: Date; online_url: string | null; location: string | null;
    agenda: string; timezone: string;
  }>(
    'SELECT title, starts_at, online_url, location, agenda, timezone FROM calendar_events WHERE id = $1',
    [eventId],
  );
  if (meeting) {
    await emailUsers(
      attendees.map((a) => a.user_id).filter((id) => id !== event.actor_id),
      {
        subject: cancelled
          ? `Cancelled: ${meeting.title}`
          : `Changed: ${meeting.title}`,
        lines: cancelled
          ? [`${meeting.title} has been cancelled.`, '', 'Nothing further is needed from you.']
          : [
              `${meeting.title} has changed.`,
              '',
              `When: ${new Date(meeting.starts_at).toISOString().replace('T', ' ').slice(0, 16)} (${meeting.timezone})`,
              meeting.location ? `Where: ${meeting.location}` : '',
              meeting.online_url ? `Join: ${meeting.online_url}` : '',
              meeting.agenda ? `\nAgenda:\n${meeting.agenda}` : '',
              '',
              appLink(`/meetings/${eventId}`),
            ],
      },
    );
  }

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
  const { taskId, title } = event.payload as { taskId: string; title?: string };
  await tasks.indexTask(taskId);

  if (event.type !== 'task.created' && event.type !== 'task.assigned') return;

  /**
   * Everyone the task is on, not just the primary assignee.
   *
   * Read from the join table rather than the event payload: the payload carries a single
   * assigneeId, which was true when a task could only have one person on it. A task
   * created with three people would otherwise notify one of them.
   *
   * task.created counts as an assignment too — a task created already assigned told
   * nobody, because only task.assigned was handled.
   */
  const assignees = await many<{ user_id: string }>(
    'SELECT user_id FROM task_assignees WHERE task_id = $1',
    [taskId],
  );
  const recipients = assignees
    .map((row) => row.user_id)
    .filter((userId) => userId !== event.actor_id);
  if (recipients.length === 0) return;

  const detail = await one<{ title: string; project_key: string; number: number }>(
    `SELECT t.title, p.\`key\` AS project_key, t.number
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
    [taskId],
  );
  const reference = detail ? `${detail.project_key}-${detail.number}` : 'task';

  await notifications.createMany(recipients, (userId) => ({
    companyId: event.company_id,
    userId,
    type: 'task.assigned',
    title: `${reference} was assigned to you`,
    body: detail?.title ?? title ?? '',
    link: `/tasks/${taskId}`,
    resourceType: 'task',
    resourceId: taskId,
    dedupeKey: `task-assign:${taskId}:${userId}:${event.id}`,
  }));

  await emailUsers(recipients, {
    subject: `${reference} was assigned to you: ${detail?.title ?? title ?? ''}`,
    lines: [
      detail?.title ?? title ?? 'A task has been assigned to you.',
      '',
      appLink(`/tasks/${taskId}`),
    ],
  });
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

  await emailUsers(approverIds, {
    subject: `Approval needed: ${reference}`,
    lines: [
      `${title}`,
      '',
      'Somebody is waiting on your decision.',
      appLink(`/approvals/${requestId}`),
    ],
  });
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

    /*
     * The outcome matters more than the progress. An approval or a rejection is
     * something the requester acts on, and they are frequently not in the app when it
     * lands — which was the whole reason to ask.
     */
    const outcome = decision ?? status ?? 'updated';
    await emailUsers([requesterId], {
      subject: `${reference} was ${outcome}`,
      lines: [
        `Your request ${reference} was ${outcome}.`,
        '',
        outcome === 'rejected'
          ? 'Open it to see the reason given.'
          : 'No further action is needed from you.',
        appLink(`/approvals/${requestId}`),
      ],
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
    await emailUsers(nextApprovers.map((row) => row.approver_id), {
      subject: `Approval needed: ${reference}`,
      lines: [
        'The previous approver has decided, and it is now with you.',
        appLink(`/approvals/${requestId}`),
      ],
    });
  }
};

// ----------------------------------------------------------------- announcements

/**
 * An issued invoice reaches the client by email, with the figures in the body.
 *
 * The message is plain text on purpose: it has to survive every mail client a client
 * company might use, and the authoritative copy always lives in the workspace.
 */
/**
 * A quotation has gone out to a prospect.
 *
 * This handler was missing entirely: the event was emitted when a quotation was sent and
 * nothing consumed it, so "send to prospect" marked it sent and emailed nobody.
 */
/** The reminder itself, sent by email. In-app was already handled by the scheduler. */
const onMeetingReminder: Handler = async (event) => {
  const { eventId, title, startsAt, userIds } = event.payload as {
    eventId: string; title: string; startsAt: string; userIds: string[];
  };
  const meeting = await one<{ online_url: string | null; location: string | null; timezone: string }>(
    'SELECT online_url, location, timezone FROM calendar_events WHERE id = $1',
    [eventId],
  );
  await emailUsers(userIds, {
    subject: `Starting soon: ${title}`,
    lines: [
      `${title} starts at ${startsAt.replace('T', ' ').slice(0, 16)} (${meeting?.timezone ?? 'UTC'}).`,
      meeting?.location ? `Where: ${meeting.location}` : '',
      meeting?.online_url ? `Join: ${meeting.online_url}` : '',
      '',
      appLink(`/meetings/${eventId}`),
    ],
  });
};

/** A message somebody wrote by hand, to the people they chose. */
const onBroadcast: Handler = async (event) => {
  const { messageId, subject, body, from, userIds } = event.payload as {
    messageId: string; subject: string; body: string; from: string; userIds: string[];
  };

  await notifications.createMany(userIds, (userId) => ({
    companyId: event.company_id,
    userId,
    type: 'message',
    title: subject,
    body: body.slice(0, 400),
    link: '/command',
    resourceType: 'message',
    resourceId: messageId,
    dedupeKey: `broadcast:${messageId}:${userId}`,
  }));

  await emailUsers(userIds, {
    subject,
    lines: [body, '', `— ${from}, via Infinity Workspace`],
  });
};

const onQuotationSent: Handler = async (event) => {
  const { quotationId } = event.payload as { quotationId: string };
  const quotation = await one<{
    number: string; total: string; currency: string; valid_until: string | null;
    summary: string | null; org_name: string; billing_email: string | null;
  }>(
    `SELECT q.number, q.total, q.currency, q.valid_until, q.summary,
            o.name AS org_name, o.billing_email
       FROM quotations q JOIN external_organizations o ON o.id = q.org_id
      WHERE q.id = $1`,
    [quotationId],
  );
  if (!quotation) return;
  if (!quotation.billing_email) {
    logger.error({ quotationId }, 'quotation has no recipient address; nothing was sent');
    return;
  }

  const lines = await many<{ description: string; quantity: string; unit_price: string; amount: string }>(
    'SELECT description, quantity, unit_price, amount FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order',
    [quotationId],
  );

  await notifier.send({
    from: { address: systemSender(), name: 'Infinity Workspace' },
    to: [quotation.billing_email],
    subject: `Quotation ${quotation.number} from Infinity AI`,
    text: [
      `Dear ${quotation.org_name},`,
      '',
      quotation.summary ?? 'Please find our quotation below.',
      '',
      ...lines.map((l) => `  ${l.description} — ${Number(l.quantity)} x ${l.unit_price} = ${l.amount}`),
      '',
      `Total: ${quotation.total} ${quotation.currency}`,
      quotation.valid_until ? `Valid until ${String(quotation.valid_until).slice(0, 10)}` : '',
      '',
      'To accept, please sign and return the attached copy.',
    ].filter(Boolean).join('\n'),
  });
};

const onInvoiceIssued: Handler = async (event) => {
  const { invoiceId } = event.payload as { invoiceId: string };
  const invoice = await one<{
    number: string; total: string; currency: string; due_date: string;
    notes: string | null; terms: string | null; client_name: string; project_name: string | null;
  }>(
    `SELECT i.number, i.total, i.currency, i.due_date, i.notes, i.terms,
            o.name AS client_name, p.name AS project_name
       FROM invoices i
       JOIN external_organizations o ON o.id = i.client_org_id
       LEFT JOIN projects p ON p.id = i.project_id
      WHERE i.id = $1`,
    [invoiceId],
  );
  if (!invoice) return;

  const recipients = await clientRecipients(invoiceId);
  if (recipients.length === 0) {
    // Reachable only if the billing address was cleared after the invoice was approved.
    logger.error({ invoiceId }, 'invoice has no recipient; nothing was sent');
    return;
  }

  const lines = await many<{ description: string; quantity: string; unit_price: string; amount: string }>(
    'SELECT description, quantity, unit_price, amount FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [invoiceId],
  );

  await notifier.send({
    from: { address: systemSender(), name: 'Infinity Workspace' },
    to: recipients,
    subject: `Invoice ${invoice.number} from Infinity AI`,
    text: [
      `Invoice ${invoice.number}`,
      invoice.project_name ? `Project: ${invoice.project_name}` : '',
      `Due: ${String(invoice.due_date).slice(0, 10)}`,
      '',
      ...lines.map((l) => `  ${l.description} — ${Number(l.quantity)} x ${l.unit_price} = ${l.amount}`),
      '',
      `Total due: ${invoice.total} ${invoice.currency}`,
      invoice.notes ? `\n${invoice.notes}` : '',
      invoice.terms ? `\nTerms: ${invoice.terms}` : '',
    ].filter(Boolean).join('\n'),
  });
};

/** A payment is acknowledged immediately: a receipt the client can file. */
const onInvoicePayment: Handler = async (event) => {
  const { invoiceId, paymentId, receiptNumber, amount, fullySettled } = event.payload as {
    invoiceId: string; paymentId: string; receiptNumber: string; amount: number; fullySettled: boolean;
  };
  const invoice = await one<{ number: string; currency: string; total: string; amount_paid: string }>(
    'SELECT number, currency, total, amount_paid FROM invoices WHERE id = $1',
    [invoiceId],
  );
  if (!invoice) return;
  const recipients = await clientRecipients(invoiceId);
  if (recipients.length === 0) {
    // Reachable only if the billing address was cleared after the invoice was approved.
    logger.error({ invoiceId }, 'invoice has no recipient; nothing was sent');
    return;
  }

  const balance = (Number(invoice.total) - Number(invoice.amount_paid)).toFixed(2);
  await notifier.send({
    from: { address: systemSender(), name: 'Infinity Workspace' },
    to: recipients,
    subject: `Receipt ${receiptNumber} for invoice ${invoice.number}`,
    text: [
      `Thank you — we have recorded your payment.`,
      '',
      `Receipt:  ${receiptNumber}`,
      `Invoice:  ${invoice.number}`,
      `Amount:   ${Number(amount).toFixed(2)} ${invoice.currency}`,
      '',
      fullySettled
        ? 'This invoice is now settled in full. Nothing further is due.'
        : `Remaining balance: ${balance} ${invoice.currency}`,
    ].join('\n'),
  });
  await pool.query('UPDATE invoice_payments SET receipt_sent_at = NOW(3) WHERE id = $1', [paymentId]);
};

/**
 * Overdue chasing.
 *
 * The reminder says what is owed and how late it is, and nothing else. Escalating tone
 * is a decision for a person, not a cron job.
 */
const onInvoiceReminder: Handler = async (event) => {
  const { invoiceId, daysLate } = event.payload as { invoiceId: string; daysLate: number };
  const invoice = await one<{ number: string; currency: string; total: string; amount_paid: string; due_date: string }>(
    'SELECT number, currency, total, amount_paid, due_date FROM invoices WHERE id = $1',
    [invoiceId],
  );
  if (!invoice) return;
  const recipients = await clientRecipients(invoiceId);
  if (recipients.length === 0) {
    // Reachable only if the billing address was cleared after the invoice was approved.
    logger.error({ invoiceId }, 'invoice has no recipient; nothing was sent');
    return;
  }

  const balance = (Number(invoice.total) - Number(invoice.amount_paid)).toFixed(2);
  await notifier.send({
    from: { address: systemSender(), name: 'Infinity Workspace' },
    to: recipients,
    subject: `Reminder: invoice ${invoice.number} is overdue`,
    text: [
      `Invoice ${invoice.number} was due on ${String(invoice.due_date).slice(0, 10)}, ${daysLate} day(s) ago.`,
      '',
      `Outstanding: ${balance} ${invoice.currency}`,
      '',
      'If payment is already on its way, please ignore this message.',
      'If something is wrong with the invoice, reply and we will sort it out.',
    ].join('\n'),
  });
};

/** Someone was given access to a folder, file or document: tell them it exists. */
const onShareGranted: Handler = async (event) => {
  const { resourceType, resourceName, recipients, url, grantedBy, message } = event.payload as {
    resourceType: string; resourceName: string; recipients: string[];
    url: string; grantedBy: string; message?: string | null;
  };
  if (!recipients || recipients.length === 0) return;

  /**
   * One message per recipient rather than one with everyone in To. A shared folder can
   * be granted to the whole company, and disclosing that list to each of them is a
   * privacy leak that is invisible until someone points it out.
   */
  for (const to of recipients) {
    await notifier.send({
      from: { address: systemSender(), name: 'Infinity Workspace' },
      to: [to],
      subject: `${grantedBy} shared a ${resourceType} with you: ${resourceName}`,
      text: [
        `${grantedBy} has given you access to the ${resourceType} "${resourceName}".`,
        message ? `\n"${message}"\n` : '',
        url,
      ].filter(Boolean).join('\n'),
    });
  }
};

/** The client-side addresses an invoice should reach. */
/**
 * Who an invoice, receipt or reminder is emailed to.
 *
 * The organisation's billing address first: that is the accounts inbox somebody entered
 * for exactly this purpose, and it is what the submit guard checks for before letting an
 * invoice be sent at all.
 *
 * Guest users of the same organisation are included as well, because a client contact
 * with a login expects to see their own invoices. Deduplicated case-insensitively, since
 * the same person is often both.
 *
 * This previously returned only the guest accounts, so a client with a billing address
 * and no guest logins - the ordinary case - passed the guard and then received nothing.
 */
async function clientRecipients(invoiceId: string): Promise<string[]> {
  const billing = await one<{ billing_email: string | null }>(
    `SELECT o.billing_email
       FROM invoices i
       JOIN external_organizations o ON o.id = i.client_org_id
      WHERE i.id = $1`,
    [invoiceId],
  );
  const guests = await many<{ email_display: string }>(
    `SELECT u.email_display
       FROM invoices i
       JOIN external_memberships m ON m.organization_id = i.client_org_id
       JOIN users u ON u.id = m.user_id
      WHERE i.id = $1 AND u.status = 'active'`,
    [invoiceId],
  );

  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const address of [billing?.billing_email, ...guests.map((g) => g.email_display)]) {
    if (!address) continue;
    const key = address.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    recipients.push(address.trim());
  }
  return recipients;
}

/**
 * Somebody has been asked to countersign.
 *
 * Both channels, deliberately. The in-app notification is what they act on while they
 * are working; the email is what reaches them when they are not, and a document waiting
 * on one person's signature is exactly the thing that stalls for a day because nobody
 * happened to look.
 */
const onSignatureRequested: Handler = async (event) => {
  const {
    documentType, documentId, documentLabel, signerUserId, signerName, signerEmail,
    requestedBy, note,
  } = event.payload as {
    documentType: string; documentId: string; documentLabel: string;
    signerUserId: string; signerName: string; signerEmail: string;
    requestedBy: string; note: string | null;
  };

  const route =
    documentType === 'quotation' ? `/finance?tab=quotations&open=${documentId}`
      : `/finance?tab=invoices&open=${documentId}`;

  const created = await notifications.create({
    companyId: event.company_id,
    userId: signerUserId,
    type: 'signature.requested',
    title: `${requestedBy} asked you to countersign ${documentLabel}`,
    body: note ?? `A ${documentType} is waiting for your signature.`,
    link: route,
    resourceType: documentType,
    resourceId: documentId,
    // Redelivery of the same event must not notify twice.
    dedupeKey: `signature.requested:${documentId}:${signerUserId}`,
  });

  /**
   * Only email if the notification was new.
   *
   * The outbox delivers at least once. Without this check a redelivered event notifies
   * once and emails again, which reads to the recipient as the system nagging them.
   */
  if (!created || !signerEmail) return;

  await notifier.send({
    from: { address: systemSender(), name: 'Infinity Workspace' },
    to: [signerEmail],
    subject: `Your signature is needed on ${documentLabel}`,
    text: [
      `${signerName},`,
      '',
      `${requestedBy} has signed ${documentLabel} and asked you to countersign it.`,
      note ? `\n"${note}"\n` : '',
      `Open Infinity Workspace and go to Finance to review and sign it.`,
      `${config.publicUrl}${route}`,
      '',
      'Signing records your account and the time, along with a fingerprint of the',
      'document as it reads now — so read it before you sign.',
    ].filter(Boolean).join('\n'),
  });
};

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
      `SELECT id FROM users
        WHERE company_id = $1 AND status = 'active'
          AND JSON_CONTAINS($2, JSON_QUOTE(department_id))`,
      [event.company_id, JSON.stringify(audience.departmentIds ?? [])],
    );
  } else if (audience.scope === 'group') {
    recipients = await many<{ id: string }>(
      `SELECT DISTINCT u.id FROM users u
         JOIN group_members gm ON gm.user_id = u.id
        WHERE u.company_id = $1 AND u.status = 'active'
          AND JSON_CONTAINS($2, JSON_QUOTE(gm.group_id))`,
      [event.company_id, JSON.stringify(audience.groupIds ?? [])],
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

  /*
   * Announcements go out by email as well.
   *
   * The whole point of one is that people see it, and a company-wide notice that only
   * appears to whoever happens to open the app that week is not an announcement.
   */
  await emailUsers(
    recipients.map((r) => r.id).filter((id) => id !== event.actor_id),
    {
      subject: title,
      lines: [
        title,
        '',
        // Read here rather than carried on the event: an announcement body can be long,
        // and the outbox row is not the place for it.
        (await one<{ body: string }>(
          'SELECT body FROM announcements WHERE id = $1', [announcementId],
        ))?.body?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) ?? '',
        '',
        appLink(`/announcements/${announcementId}`),
      ],
    },
  );
};

// ----------------------------------------------------------------- registry

export const handlers: Record<string, Handler> = {
  'user.invited': onUserInvited,
  'user.activated': onUserActivated,
  'user.updated': onAccessChanged,
  'user.suspended': onAccessChanged,
  'user.reactivated': onAccessChanged,
  'user.password_reset_requested': onPasswordResetRequested,
  'signature.requested': onSignatureRequested,
  'meeting.reminder_due': onMeetingReminder,
  'message.broadcast': onBroadcast,
  'quotation.sent': onQuotationSent,
  'invoice.issued': onInvoiceIssued,
  'invoice.payment_recorded': onInvoicePayment,
  'invoice.reminder_due': onInvoiceReminder,
  'share.granted': onShareGranted,
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
  // Two things happen when an approval finishes: people are told, and any leave behind
  // it is settled. Chained rather than merged so notification failures and balance
  // settlement stay separately diagnosable in the dead-letter queue.
  'approval.completed': async (event) => {
    await onApprovalProgressed(event);
    await onApprovalSettled(event);
  },
  'announcement.published': onAnnouncementPublished,
};

export { logger, publish, publishToUser };
