/**
 * Scheduled maintenance (blueprint 14).
 *
 * Meeting reminders, retention enforcement, session and counter housekeeping, approval
 * escalation and upload-session cleanup. Each job is guarded by an advisory lock so a
 * multi-instance deployment runs it once, not once per instance.
 */
import { many, pool } from '../core/db.js';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import * as notifications from '../domains/notifications.js';
import * as approvals from '../domains/approvals.js';
import { purgeExpired } from '../core/ratelimit.js';
import { storage } from '../adapters/storage.js';

type Job = { name: string; intervalMs: number; lockKey: number; run: () => Promise<void> };

/**
 * Runs `fn` only if this instance wins the advisory lock, so concurrent API instances
 * do not duplicate scheduled work.
 */
async function withLock(lockKey: number, fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      lockKey,
    ]);
    if (!res.rows[0]?.locked) return;
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    client.release();
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
        AND starts_at > now()
        AND starts_at <= now() + (reminder_minutes || ' minutes')::interval
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
      WHERE state = 'recycled' AND retention_until IS NOT NULL AND retention_until < now()
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
    await pool.query(`UPDATE files SET state = 'expired', updated_at = now() WHERE id = $1`, [file.id]);
    await pool.query('DELETE FROM search_documents WHERE doc_type = $1 AND resource_id = $2', [
      'file',
      file.id,
    ]);
  }

  await pool.query(
    `DELETE FROM notifications WHERE created_at < now() - ($1 || ' days')::interval`,
    [config.retention.notificationDays],
  );
}

/** Expired sessions, used invitations, stale upload sessions and rate counters. */
async function housekeeping(): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
  await pool.query(`DELETE FROM invitations WHERE expires_at < now() - interval '30 days'`);
  await pool.query(
    `UPDATE upload_sessions SET state = 'aborted' WHERE state = 'open' AND expires_at < now()`,
  );
  await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - interval '48 hours'`,
  );
  await purgeExpired();

  // An upload that never completed leaves a file stuck in processing.
  await pool.query(
    `UPDATE files SET state = 'expired', updated_at = now()
      WHERE state = 'processing' AND created_at < now() - interval '24 hours'`,
  );
}

async function escalateApprovals(): Promise<void> {
  const count = await approvals.escalateOverdue();
  if (count > 0) logger.info({ count }, 'escalated overdue approval requests');
}

/** Surfaces queue backlog as a log signal that alerting can key on. */
async function queueHealth(): Promise<void> {
  const res = await pool.query<{ pending: number; oldest: number | null }>(
    `SELECT count(*)::int AS pending,
            EXTRACT(EPOCH FROM (now() - min(available_at)))::int AS oldest
       FROM outbox_events WHERE processed_at IS NULL`,
  );
  const pending = res.rows[0]?.pending ?? 0;
  const oldest = res.rows[0]?.oldest ?? 0;
  if (pending > 1000 || oldest > 300) {
    logger.warn({ pending, oldestSeconds: oldest }, 'outbox backlog exceeds threshold');
  }
}

const jobs: Job[] = [
  { name: 'meeting-reminders', intervalMs: 60_000, lockKey: 811_001, run: meetingReminders },
  { name: 'retention', intervalMs: 3_600_000, lockKey: 811_002, run: enforceRetention },
  { name: 'housekeeping', intervalMs: 900_000, lockKey: 811_003, run: housekeeping },
  { name: 'approval-escalation', intervalMs: 600_000, lockKey: 811_004, run: escalateApprovals },
  { name: 'queue-health', intervalMs: 60_000, lockKey: 811_005, run: queueHealth },
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
