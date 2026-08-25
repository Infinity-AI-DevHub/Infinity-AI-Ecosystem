/**
 * Notifications. Created by domain workers reacting to outbox events, delivered over
 * WebSocket to connected users and persisted so they survive refresh and device change.
 */
import { many, one, pool, type Queryable } from '../core/db.js';
import { publishToUser } from '../core/realtime.js';
import { decodeCursor, encodeCursor } from '../core/validation.js';
import { notFound } from '../core/errors.js';

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

export async function create(input: NotificationInput, db: Queryable = pool): Promise<void> {
  const res = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO notifications
       (company_id, user_id, type, title, body, link, resource_type, resource_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, created_at`,
    [
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
  const row = res.rows[0];
  if (!row) return; // deduplicated
  publishToUser(input.userId, 'notification.created', {
    id: row.id,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
    createdAt: row.created_at,
  });
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
        AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
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
    'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return row?.count ?? 0;
}

export async function markRead(userId: string, id: string): Promise<void> {
  const res = await pool.query(
    'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
    [id, userId],
  );
  if (res.rowCount === 0) {
    const exists = await one('SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!exists) throw notFound('Notification not found');
  }
}

export async function markAllRead(userId: string): Promise<number> {
  const res = await pool.query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return res.rowCount ?? 0;
}
