/**
 * Scheduled maintenance (blueprint 14).
 *
 * Meeting reminders, retention enforcement, session and counter housekeeping, approval
 * escalation and upload-session cleanup. Each job is guarded by an advisory lock so a
 * multi-instance deployment runs it once, not once per instance.
 */
import { many, pool } from '../core/db.js';
import { emit } from '../core/outbox.js';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import * as notifications from '../domains/notifications.js';
import * as approvals from '../domains/approvals.js';
import { purgeExpired } from '../core/ratelimit.js';
import { storage } from '../adapters/storage.js';

type Job = { name: string; intervalMs: number; lockKey: string; run: () => Promise<void> };

/**
 * Runs `fn` only if this instance wins the named lock, so concurrent API instances do
 * not duplicate scheduled work.
 *
 * MySQL's GET_LOCK is held by a connection, so the lock must be taken and released on
 * one dedicated connection rather than through the pool. A zero timeout means an
 * instance that loses the race skips this tick instead of queuing behind the winner.
 */
async function withLock(lockKey: string, fn: () => Promise<void>): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS locked', [lockKey]);
    if ((rows as { locked: number }[])[0]?.locked !== 1) return;
    try {
      await fn();
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockKey]);
    }
  } finally {
    connection.release();
  }
}

/** Notifies attendees shortly before a meeting starts, exactly once per meeting. */
async function meetingReminders(): Promise<void> {
  const due = await many<{
    id: string;
    company_id: string;
    title: string;
    starts_at: Date;
    reminder_minutes: number;
  }>(
    `SELECT id, company_id, title, starts_at, reminder_minutes
       FROM calendar_events
      WHERE status = 'confirmed'
        AND starts_at > NOW(3)
        AND starts_at <= DATE_ADD(NOW(3), INTERVAL reminder_minutes MINUTE)
      LIMIT 200`,
  );

  for (const event of due) {
    const attendees = await many<{ user_id: string }>(
      `SELECT user_id FROM event_attendees WHERE event_id = $1 AND rsvp <> 'declined'`,
      [event.id],
    );
    await notifications.createMany(
      attendees.map((a) => a.user_id),
      (userId) => ({
        companyId: event.company_id,
        userId,
        type: 'meeting.reminder',
        title: `Starting soon: ${event.title}`,
        body: new Date(event.starts_at).toISOString(),
        link: `/meetings/${event.id}`,
        resourceType: 'calendar_event',
        resourceId: event.id,
        // The dedupe key is what makes the reminder fire once, not on every tick.
        dedupeKey: `meeting-reminder:${event.id}:${userId}`,
      }),
    );
  }
}

/**
 * Retention (blueprint 07). Recycled files past their window are purged from object
 * storage and the database; anything under legal hold is left untouched.
 */
async function enforceRetention(): Promise<void> {
  const expired = await many<{ id: string; company_id: string }>(
    `SELECT id, company_id FROM files
      WHERE state = 'recycled' AND retention_until IS NOT NULL AND retention_until < NOW(3)
      LIMIT 100`,
  );

  for (const file of expired) {
    const versions = await many<{ object_key: string }>(
      'SELECT object_key FROM file_versions WHERE file_id = $1',
      [file.id],
    );
    for (const version of versions) {
      try {
        await storage.delete(version.object_key);
      } catch (err) {
        // A storage failure must not delete the database record and orphan the object.
        logger.error({ err, fileId: file.id }, 'failed to delete expired object; will retry');
        return;
      }
    }
    await pool.query(`UPDATE files SET state = 'expired', updated_at = NOW(3) WHERE id = $1`, [file.id]);
    await pool.query('DELETE FROM search_documents WHERE doc_type = $1 AND resource_id = $2', [
      'file',
      file.id,
    ]);
  }

  await pool.query(
    `DELETE FROM notifications WHERE created_at < DATE_SUB(NOW(3), INTERVAL $1 DAY)`,
    [config.retention.notificationDays],
  );
}

/** Expired sessions, used invitations, stale upload sessions and rate counters. */
async function housekeeping(): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)`);
  await pool.query(`DELETE FROM invitations WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 30 DAY)`);
  await pool.query(
    `UPDATE upload_sessions SET state = 'aborted' WHERE state = 'open' AND expires_at < NOW(3)`,
  );
  await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < DATE_SUB(NOW(3), INTERVAL 48 HOUR)`,
  );
  await purgeExpired();

  // An upload that never completed leaves a file stuck in processing.
  await pool.query(
    `UPDATE files SET state = 'expired', updated_at = NOW(3)
      WHERE state = 'processing' AND created_at < DATE_SUB(NOW(3), INTERVAL 24 HOUR)`,
  );
}

async function escalateApprovals(): Promise<void> {
  const count = await approvals.escalateOverdue();
  if (count > 0) logger.info({ count }, 'escalated overdue approval requests');
}

/** Surfaces queue backlog as a log signal that alerting can key on. */
async function queueHealth(): Promise<void> {
  const res = await pool.query<{ pending: number; oldest: number | null }>(
    `SELECT count(*) AS pending,
            TIMESTAMPDIFF(SECOND, min(available_at), NOW(3)) AS oldest
       FROM outbox_events WHERE processed_at IS NULL`,
  );
  const pending = res.rows[0]?.pending ?? 0;
  const oldest = res.rows[0]?.oldest ?? 0;
  if (pending > 1000 || oldest > 300) {
    logger.warn({ pending, oldestSeconds: oldest }, 'outbox backlog exceeds threshold');
  }
}


/**
 * Overdue invoice reminders.
 *
 * The cadence is per invoice, so a client on 30-day terms and one who always pays late
 * can be chased differently without a global setting that suits neither.
 *
 * The claim is the UPDATE, not the SELECT. Stamping reminder_last_sent_at in the same
 * statement that re-checks the condition means two workers cannot both pick up the same
 * invoice and send a client the same chase twice - which is the failure people notice.
 */
async function invoiceReminders(): Promise<void> {
  const due = await many<{ id: string; company_id: string; days_late: number }>(
    `SELECT id, company_id, DATEDIFF(CURDATE(), due_date) AS days_late
       FROM invoices
      WHERE reminders_enabled = 1
        AND status IN ('open','partially_paid')
        AND due_date < CURDATE()
        AND (total - amount_paid) > 0
        AND (reminder_last_sent_at IS NULL
             OR reminder_last_sent_at < DATE_SUB(NOW(3), INTERVAL reminder_interval_days DAY))
      ORDER BY due_date
      LIMIT 200`,
  );

  for (const invoice of due) {
    // Re-check inside the claim: between the read above and here the client may have
    // paid, and nobody should be chased for an invoice that is already settled.
    const claimed = await pool.query(
      `UPDATE invoices
          SET reminder_last_sent_at = NOW(3), reminder_count = reminder_count + 1
        WHERE id = $1
          AND reminders_enabled = 1
          AND status IN ('open','partially_paid')
          AND (total - amount_paid) > 0
          AND (reminder_last_sent_at IS NULL
               OR reminder_last_sent_at < DATE_SUB(NOW(3), INTERVAL reminder_interval_days DAY))`,
      [invoice.id],
    );
    if ((claimed.rowCount ?? 0) === 0) continue;

    await emit({
      companyId: invoice.company_id,
      type: 'invoice.reminder_due',
      payload: { invoiceId: invoice.id, daysLate: Number(invoice.days_late) },
    });
  }
}

const jobs: Job[] = [
  { name: 'meeting-reminders', intervalMs: 60_000, lockKey: 'iw_meeting_reminders', run: meetingReminders },
  { name: 'retention', intervalMs: 3_600_000, lockKey: 'iw_retention', run: enforceRetention },
  { name: 'housekeeping', intervalMs: 900_000, lockKey: 'iw_housekeeping', run: housekeeping },
  { name: 'approval-escalation', intervalMs: 600_000, lockKey: 'iw_approval_escalation', run: escalateApprovals },
  { name: 'queue-health', intervalMs: 60_000, lockKey: 'iw_queue_health', run: queueHealth },
  // Hourly: the cadence is measured in days, so a tighter tick only adds load.
  { name: 'invoice-reminders', intervalMs: 3_600_000, lockKey: 'iw_invoice_reminders', run: invoiceReminders },
];

const timers: NodeJS.Timeout[] = [];

export function startScheduler(): void {
  for (const job of jobs) {
    const tick = async () => {
      try {
        await withLock(job.lockKey, job.run);
      } catch (err) {
        logger.error({ err, job: job.name }, 'scheduled job failed');
      }
    };
    // Stagger the first run so every job does not fire at the same instant on boot.
    const initialDelay = 5_000 + Math.floor(Math.random() * 10_000);
    timers.push(setTimeout(() => {
      void tick();
      timers.push(setInterval(() => void tick(), job.intervalMs));
    }, initialDelay));
  }
  logger.info({ jobs: jobs.map((j) => j.name) }, 'scheduler started');
}

export function stopScheduler(): void {
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.length = 0;
}

/** Exposed so operators and tests can run a job on demand. */
export async function runJob(name: string): Promise<void> {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  await job.run();
}
