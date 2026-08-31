/**
 * Per-module attention counts: what the sidebar badges show.
 *
 * One query per module rather than one endpoint per module, because the sidebar needs
 * all of them on every screen and six round trips to render a navigation bar is six
 * round trips too many.
 *
 * Every count is scoped to this actor and gated on the capability that governs the
 * module. A badge is a disclosure: "you have 3 pending approvals" tells someone that
 * approvals exist and that they are involved in them, so it must not appear for a
 * person who could not open the page.
 */
import { one } from '../core/db.js';
import type { Actor } from '../core/authz.js';

export type ActivityCounts = {
  chat: number;
  tasks: number;
  approvals: number;
  invoices: number;
  announcements: number;
  leave: number;
};

export async function counts(actor: Actor): Promise<ActivityCounts> {
  const can = (capability: string) => actor.capabilities.has(capability);

  const row = await one<Record<string, number>>(
    `SELECT
       -- Unread chat. The read marker is a per-room sequence number, not a timestamp
       -- and not the message id - ids are UUIDs and do not order.
       (SELECT COUNT(*)
          FROM chat_messages m
          JOIN chat_members cm ON cm.room_id = m.room_id AND cm.user_id = $2
         WHERE m.company_id = $1
           AND m.author_id <> $2
           AND m.deleted_at IS NULL
           AND m.seq > cm.read_cursor) AS chat,

       -- Tasks assigned to this person and not finished.
       (SELECT COUNT(*) FROM tasks t
         WHERE t.company_id = $1 AND t.assignee_id = $2
           AND t.status NOT IN ('done','cancelled')) AS tasks,

       -- Approvals genuinely waiting on this person, not merely in flight.
       (SELECT COUNT(DISTINCT ar.id)
          FROM approval_requests ar
          JOIN approval_steps s ON s.request_id = ar.id AND s.state = 'active'
         WHERE ar.company_id = $1 AND ar.status = 'pending'
           AND s.approver_id = $2) AS approvals,

       -- Invoices awaiting a release decision.
       (SELECT COUNT(*) FROM invoices i
         WHERE i.company_id = $1 AND i.status = 'pending_approval') AS invoices,

       -- Published announcements this person has not opened.
       (SELECT COUNT(*)
          FROM announcements a
          LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $2
         WHERE a.company_id = $1 AND a.state = 'published'
           AND a.publish_at <= NOW(3)
           AND (a.expires_at IS NULL OR a.expires_at > NOW(3))
           AND r.read_at IS NULL) AS announcements,

       -- Leave requests waiting on this person. Leave has no approver column of its
       -- own: it routes through the ordinary approval machinery, so the pending step
       -- is what says whose desk it is on.
       (SELECT COUNT(DISTINCT lr.id)
          FROM leave_requests lr
          JOIN approval_steps s ON s.request_id = lr.approval_request_id
                               AND s.state = 'active' AND s.approver_id = $2
         WHERE lr.company_id = $1 AND lr.status = 'pending') AS \`leave\``,
    [actor.companyId, actor.userId],
  );

  const value = (key: string, capability: string | null) =>
    capability && !can(capability) ? 0 : Number(row?.[key] ?? 0);

  return {
    chat: value('chat', null),
    tasks: value('tasks', null),
    approvals: value('approvals', null),
    invoices: value('invoices', 'invoice.approve'),
    announcements: value('announcements', null),
    leave: value('leave', 'leave.read_all'),
  };
}
