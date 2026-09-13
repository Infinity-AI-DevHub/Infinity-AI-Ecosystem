/**
 * Command dashboard (blueprint 04).
 *
 * Each widget loads independently and failures are isolated, so one degraded service
 * cannot blank the page. Every widget respects the caller's permissions.
 */
import { one, many } from '../core/db.js';
import { hasCapability, type Actor } from '../core/authz.js';
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
  const [meetings, tasks, approvals, notifications, announcements, storage, work, attendance] =
    await Promise.all([
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

    /**
     * How the person's own work is going.
     *
     * The dashboard could say what was assigned but never how it was going, so somebody
     * whose whole day is their board had to open it to learn anything. Counted rather
     * than listed: the list is one widget along.
     */
    widget('work', async () => {
      const row = await one<{
        open_tasks: number; due_soon: number; overdue: number;
        done_this_week: number; assigned_this_month: number; done_this_month: number;
      }>(
        `SELECT
           SUM(t.status NOT IN ('done','cancelled'))                                    AS open_tasks,
           SUM(t.status NOT IN ('done','cancelled')
               AND t.due_at IS NOT NULL
               AND t.due_at BETWEEN NOW(3) AND DATE_ADD(NOW(3), INTERVAL 7 DAY))        AS due_soon,
           SUM(t.status NOT IN ('done','cancelled')
               AND t.due_at IS NOT NULL AND t.due_at < NOW(3))                          AS overdue,
           SUM(t.status = 'done' AND t.completed_at >= DATE_SUB(NOW(3), INTERVAL 7 DAY)) AS done_this_week,
           SUM(t.created_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY))                        AS assigned_this_month,
           SUM(t.status = 'done' AND t.completed_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)) AS done_this_month
         FROM tasks t
        WHERE t.company_id = $2
          AND (t.assignee_id = $1
               OR EXISTS (SELECT 1 FROM task_assignees ta
                           WHERE ta.task_id = t.id AND ta.user_id = $1))`,
        [actor.userId, actor.companyId],
      );
      const assigned = Number(row?.assigned_this_month ?? 0);
      const done = Number(row?.done_this_month ?? 0);
      return {
        openTasks: Number(row?.open_tasks ?? 0),
        dueSoon: Number(row?.due_soon ?? 0),
        overdue: Number(row?.overdue ?? 0),
        doneThisWeek: Number(row?.done_this_week ?? 0),
        // Nothing assigned is not nought per cent done — it is simply nothing to report.
        completionRate: assigned === 0 ? null : Math.round((done / assigned) * 100),
      };
    }),

    /**
     * Attendance, against the policy rather than in raw minutes.
     *
     * The number that matters to an employee is whether today clears six hours and how
     * the week is going, not a total they have to do arithmetic on. Weekends carry no
     * minimum, so they are counted as time worked and never as a shortfall.
     */
    widget('attendance', async () => {
      const rows = await many<{ day: string; minutes: number; sessions: number }>(
        // Formatted in SQL: the driver hands DATE() back as a JS Date, whose string
        // form is "Thu Sep 03 2026 ...". Slicing that gave "Thu Sep 03", which never
        // matched today's ISO date, so today's total silently read as zero.
        `SELECT DATE_FORMAT(clocked_in_at, '%Y-%m-%d') AS day,
                SUM(COALESCE(worked_minutes,
                             GREATEST(0, TIMESTAMPDIFF(MINUTE, clocked_in_at, NOW(3))))) AS minutes,
                COUNT(*) AS sessions
           FROM attendance_sessions
          WHERE user_id = $1 AND company_id = $2
            AND clocked_in_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
          GROUP BY DATE_FORMAT(clocked_in_at, '%Y-%m-%d')
          ORDER BY day`,
        [actor.userId, actor.companyId],
      );
      const days = rows.map((r) => {
        const date = new Date(`${String(r.day).slice(0, 10)}T12:00:00Z`);
        const weekday = date.getUTCDay();
        return {
          day: String(r.day).slice(0, 10),
          minutes: Number(r.minutes ?? 0),
          workingDay: weekday !== 0 && weekday !== 6,
        };
      });
      const today = new Date().toISOString().slice(0, 10);
      const MINIMUM = 6 * 60;
      const workingDays = days.filter((d) => d.workingDay);
      return {
        minimumMinutes: MINIMUM,
        todayMinutes: days.find((d) => d.day === today)?.minutes ?? 0,
        weekMinutes: days.reduce((total, d) => total + d.minutes, 0),
        daysMetMinimum: workingDays.filter((d) => d.minutes >= MINIMUM).length,
        workingDaysRecorded: workingDays.length,
        days,
      };
    }),
  ]);

  /**
   * Client activity: what clients have sent recently and what they owe.
   *
   * Only for people whose role reads client organisations, and the invoice half only for
   * those who also read invoices. A role without either gets no key at all rather than
   * an empty widget, so the page does not offer a section it cannot fill.
   */
  const clients = hasCapability(actor, 'external_org.read')
    ? await widget('clients', async () => {
        const uploads = await many<{
          id: string; org_id: string; org_name: string; file_name: string; kind: string; created_at: string;
        }>(
          `SELECT pu.id, pu.org_id, o.name AS org_name, f.name AS file_name, pu.kind, pu.created_at
             FROM portal_uploads pu
             JOIN external_organizations o ON o.id = pu.org_id AND o.company_id = pu.company_id
             JOIN files f ON f.id = pu.file_id
            WHERE pu.company_id = $1 AND pu.created_at >= DATE_SUB(NOW(3), INTERVAL 14 DAY)
            ORDER BY pu.created_at DESC
            LIMIT 5`,
          [actor.companyId],
        );
        let invoices: { overdue: number; outstanding: number } | null = null;
        if (hasCapability(actor, 'invoice.read')) {
          const row = await one<{ overdue: number; outstanding: number }>(
            `SELECT
               SUM(status IN ('open','partially_paid') AND due_date < CURDATE() AND (total - amount_paid) > 0) AS overdue,
               SUM(status IN ('open','partially_paid')) AS outstanding
             FROM invoices WHERE company_id = $1`,
            [actor.companyId],
          );
          invoices = { overdue: Number(row?.overdue ?? 0), outstanding: Number(row?.outstanding ?? 0) };
        }
        return { uploads, invoices };
      })
    : undefined;

  /**
   * Service desk work, for people who work a queue. Absent for everyone else, so the
   * section never appears as an empty box for someone who only raises requests.
   */
  const queueRows = await many<{ queue_id: string }>(
    'SELECT queue_id FROM service_queue_members WHERE user_id = $1 AND company_id = $2',
    [actor.userId, actor.companyId],
  ).catch(() => []);
  const worksDesk = hasCapability(actor, 'ticket.work') || queueRows.length > 0;
  const service = worksDesk
    ? await widget('service', async () => {
        const all = hasCapability(actor, 'ticket.work');
        const ids = queueRows.map((r) => r.queue_id);
        const scope = all ? '' : `AND t.queue_id IN (${ids.map((_, i) => `$${i + 3}`).join(',')})`;
        const counts = await one<{ assigned: number; unassigned: number; breached: number; mine_breached: number }>(
          `SELECT
             SUM(t.assignee_id = $2) AS assigned,
             SUM(t.assignee_id IS NULL) AS unassigned,
             SUM(t.response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL) AS breached,
             SUM(t.assignee_id = $2 AND (t.response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL)) AS mine_breached
           FROM tickets t
          WHERE t.company_id = $1 AND t.status IN ('new','open','pending') ${scope}`,
          [actor.companyId, actor.userId, ...(all ? [] : ids)],
        );
        const urgent = await many<{ id: string; number: number; subject: string; priority: string; status: string; assignee_id: string | null; resolution_due_at: string | null; breached: number }>(
          `SELECT t.id, t.number, t.subject, t.priority, t.status, t.assignee_id, t.resolution_due_at,
                  (t.response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL) AS breached
             FROM tickets t
            WHERE t.company_id = $1 AND t.status IN ('new','open','pending')
              AND (t.assignee_id = $2 OR t.assignee_id IS NULL) ${scope}
            ORDER BY breached DESC, FIELD(t.priority, 'urgent','high','normal','low'), t.resolution_due_at
            LIMIT 6`,
          [actor.companyId, actor.userId, ...(all ? [] : ids)],
        );
        return {
          assigned: Number(counts?.assigned ?? 0),
          unassigned: Number(counts?.unassigned ?? 0),
          breached: Number(counts?.breached ?? 0),
          mineBreached: Number(counts?.mine_breached ?? 0),
          tickets: urgent.map((t) => ({ ...t, ref: `SD-${t.number}`, breached: Boolean(t.breached), mine: t.assignee_id === actor.userId })),
        };
      })
    : undefined;

  return { meetings, tasks, approvals, notifications, announcements, storage, work, attendance, clients, service };
}
