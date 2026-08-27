/**
 * Command dashboard (blueprint 04).
 *
 * Each widget loads independently and failures are isolated, so one degraded service
 * cannot blank the page. Every widget respects the caller's permissions.
 */
import { one, many } from '../core/db.js';
import type { Actor } from '../core/authz.js';
import { logger } from '../core/logger.js';

export type Widget<T> = { state: 'ok'; data: T } | { state: 'unavailable'; reason: string };

async function widget<T>(name: string, load: () => Promise<T>): Promise<Widget<T>> {
  try {
    return { state: 'ok', data: await load() };
  } catch (err) {
    logger.warn({ err, widget: name }, 'dashboard widget failed');
    return { state: 'unavailable', reason: 'This section could not be loaded right now' };
  }
}

export async function build(actor: Actor) {
  const [meetings, tasks, approvals, notifications, announcements, storage] = await Promise.all([
    widget('meetings', async () =>
      many(
        `SELECT e.id, e.title, e.starts_at, e.ends_at, e.timezone, e.meeting_room_key IS NOT NULL AS has_video,
                a.rsvp
           FROM calendar_events e
           JOIN event_attendees a ON a.event_id = e.id AND a.user_id = $1
          WHERE e.status = 'confirmed'
            AND e.ends_at > NOW(3) AND e.starts_at < DATE_ADD(NOW(3), INTERVAL 24 HOUR)
          ORDER BY e.starts_at LIMIT 8`,
        [actor.userId],
      ),
    ),

    widget('tasks', async () =>
      many(
        `SELECT t.id, t.title, t.status, t.priority, t.due_at, p.key AS project_key, t.number
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.assignee_id = $1 AND t.status NOT IN ('done','cancelled')
          ORDER BY (t.due_at IS NULL), t.due_at, t.priority DESC LIMIT 10`,
        [actor.userId],
      ),
    ),

    widget('approvals', async () => {
      const row = await one<{ awaiting: number; mine_pending: number }>(
        `SELECT
           (SELECT count(*) FROM approval_requests r
              JOIN approval_steps s ON s.request_id = r.id
             WHERE r.status = 'pending' AND s.approver_id = $1
               AND s.step_number = r.current_step AND s.state = 'active') AS awaiting,
           (SELECT count(*) FROM approval_requests
             WHERE requester_id = $1 AND status = 'pending') AS mine_pending`,
        [actor.userId],
      );
      return row ?? { awaiting: 0, mine_pending: 0 };
    }),

    widget('notifications', async () => {
      const row = await one<{ unread: number }>(
        'SELECT count(*) AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL',
        [actor.userId],
      );
      return { unread: row?.unread ?? 0 };
    }),

    widget('announcements', async () => {
      const { listForUser } = await import('./announcements.js');
      return listForUser(actor, 3);
    }),

    widget('storage', async () => {
      const row = await one<{ used: number; files: number }>(
        `SELECT COALESCE(sum(size_bytes),0) AS used, count(*) AS files
           FROM files WHERE company_id = $1 AND state = 'active'`,
        [actor.companyId],
      );
      return { usedBytes: Number(row?.used ?? 0), fileCount: row?.files ?? 0 };
    }),
  ]);

  return { meetings, tasks, approvals, notifications, announcements, storage };
}
