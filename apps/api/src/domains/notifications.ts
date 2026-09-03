/**
 * Notifications. Created by domain workers reacting to outbox events, delivered over
 * WebSocket to connected users and persisted so they survive refresh and device change.
 */
import { many, newId, one, pool, type Queryable } from '../core/db.js';
import { publishToUser } from '../core/realtime.js';
import { decodeCursor, encodeCursor } from '../core/validation.js';
import { notFound } from '../core/errors.js';

/**
 * How loudly a notification should announce itself.
 *
 * Derived from the type rather than stored, because severity is a property of the kind
 * of event, not of one instance of it - a quarantined file is always serious, and a task
 * assignment never is.
 *
 * The default is deliberately the quiet one. Anything unclassified is information; if
 * everything were a warning the warning would stop meaning anything, and people would
 * learn to dismiss the banner that actually matters.
 */
export type Severity = 'info' | 'success' | 'warning' | 'critical';

const SEVERITY: Record<string, Severity> = {
  // Malware found in something an employee uploaded, and it may already be shared.
  'file.quarantined': 'critical',
  // Someone is blocked until this person acts.
  'approval.awaiting': 'warning',
  'signature.requested': 'warning',
  'invoice.overdue': 'warning',
  // Outcomes worth confirming rather than interrupting for.
  'approval.progress': 'success',
  'invoice.paid': 'success',
  welcome: 'success',
};

export function severityFor(type: string): Severity {
  if (SEVERITY[type]) return SEVERITY[type];
  // Announcements carry their own priority, which the publisher already set.
  if (type.startsWith('announcement.critical')) return 'critical';
  return 'info';
}

export type NotificationInput = {
  companyId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  resourceType?: string;
  resourceId?: string;
  /** Prevents duplicate notifications when an event is retried. */
  dedupeKey?: string;
};

/**
 * Returns whether a notification was actually created.
 *
 * The outbox delivers at least once, so a handler may run twice for the same event. The
 * dedupe key already stops a duplicate row — but a handler that also sends an email needs
 * to know it was a duplicate, or the person is notified once and emailed twice.
 */
export async function create(input: NotificationInput, db: Queryable = pool): Promise<boolean> {
  // INSERT IGNORE lets the dedupe key silently drop a repeat rather than raising,
  // which is what makes a redelivered event safe to process twice.
  const id = newId();
  const res = await db.query(
    `INSERT IGNORE INTO notifications
       (id, company_id, user_id, type, title, body, link, resource_type, resource_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.companyId,
      input.userId,
      input.type,
      input.title,
      input.body ?? null,
      input.link ?? null,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.dedupeKey ?? null,
    ],
  );
  if (res.rowCount === 0) return false; // deduplicated
  publishToUser(input.userId, 'notification.created', {
    id,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
    // The client decides whether to make a noise; it needs to be told how loud.
    severity: severityFor(input.type),
    createdAt: new Date().toISOString(),
  });
  return true;
}

/** Fan-out helper that skips the actor so people are not notified of their own actions. */
export async function createMany(
  userIds: string[],
  build: (userId: string) => NotificationInput,
  exclude?: string | null,
): Promise<void> {
  const unique = [...new Set(userIds)].filter((id) => id && id !== exclude);
  for (const userId of unique) {
    await create(build(userId));
  }
}

export async function list(userId: string, opts: { limit: number; cursor?: string; unreadOnly?: boolean }) {
  const cursor = decodeCursor(opts.cursor);
  const rows = await many<{
    id: string;
    type: string;
    title: string;
    body: string | null;
    link: string | null;
    resource_type: string | null;
    resource_id: string | null;
    read_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, type, title, body, link, resource_type, resource_id, read_at, created_at
       FROM notifications
      WHERE user_id = $1
        AND dismissed_at IS NULL
        AND ($2 IS NOT TRUE OR read_at IS NULL)
        AND ($3 IS NULL OR (created_at, id) < ($3, $4))
      ORDER BY created_at DESC, id DESC
      LIMIT $5`,
    [userId, opts.unreadOnly ?? false, cursor?.at ?? null, cursor?.id ?? null, opts.limit + 1],
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
  };
}

export async function unreadCount(userId: string): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT count(*) AS count FROM notifications
      WHERE user_id = $1 AND read_at IS NULL AND dismissed_at IS NULL`,
    [userId],
  );
  return row?.count ?? 0;
}

export async function markRead(userId: string, id: string): Promise<void> {
  const res = await pool.query(
    'UPDATE notifications SET read_at = NOW(3) WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
    [id, userId],
  );
  if (res.rowCount === 0) {
    const exists = await one('SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!exists) throw notFound('Notification not found');
  }
}

export async function markAllRead(userId: string): Promise<number> {
  const res = await pool.query(
    'UPDATE notifications SET read_at = NOW(3) WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return res.rowCount ?? 0;
}

/**
 * Clear one notification.
 *
 * Dismissed, not deleted: the dedupe key is what stops a redelivered event producing a
 * second copy, and removing the row would let a retry resurrect something the person had
 * deliberately cleared. Retention deletes it later like any other.
 *
 * Marked read at the same time, so a dismissed item cannot go on contributing to the
 * unread badge — clearing something you never opened is still dealing with it.
 */
export async function dismiss(userId: string, id: string): Promise<void> {
  await pool.query(
    `UPDATE notifications
        SET dismissed_at = NOW(3), read_at = COALESCE(read_at, NOW(3))
      WHERE id = $1 AND user_id = $2 AND dismissed_at IS NULL`,
    [id, userId],
  );
}

/** Clear everything currently in the panel. Returns how many were cleared. */
export async function dismissAll(userId: string): Promise<number> {
  const res = await pool.query(
    `UPDATE notifications
        SET dismissed_at = NOW(3), read_at = COALESCE(read_at, NOW(3))
      WHERE user_id = $1 AND dismissed_at IS NULL`,
    [userId],
  );
  return res.rowCount;
}
