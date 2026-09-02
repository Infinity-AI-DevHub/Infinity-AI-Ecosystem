/**
 * Transactional outbox (blueprint 06). Domain code emits events inside the same
 * transaction as the state change; the dispatcher publishes them afterwards, so the
 * database and the event stream cannot diverge.
 */
import { randomUUID } from 'node:crypto';
import { pool, transaction, type Queryable } from './db.js';

export type DomainEventType =
  | 'user.invited'
  | 'user.activated'
  | 'user.updated'
  | 'user.suspended'
  | 'user.reactivated'
  | 'user.password_reset_requested'
  | 'user.offboarded'
  | 'session.revoked'
  | 'event.scheduled'
  | 'event.updated'
  | 'event.cancelled'
  | 'event.rsvp'
  | 'chat.message.created'
  | 'chat.message.updated'
  | 'chat.member.added'
  | 'task.created'
  | 'task.updated'
  | 'task.assigned'
  | 'file.created'
  | 'file.versioned'
  | 'file.scanned'
  | 'file.recycled'
  | 'quotation.sent'
  | 'signature.requested'
  | 'message.broadcast'
  | 'meeting.reminder_due'
  | 'invoice.issued'
  | 'invoice.payment_recorded'
  | 'invoice.reminder_due'
  | 'share.granted'
  | 'approval.requested'
  | 'approval.decided'
  | 'approval.completed'
  | 'announcement.published'
  | 'notification.created';

export type OutboxEvent = {
  companyId: string;
  type: DomainEventType;
  payload: Record<string, unknown>;
  actorId?: string | null;
  correlationId?: string | null;
  availableAt?: Date;
};

export async function emit(event: OutboxEvent, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO outbox_events (company_id, type, payload, actor_id, correlation_id, available_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW(3)))`,
    [
      event.companyId,
      event.type,
      JSON.stringify(event.payload),
      event.actorId ?? null,
      event.correlationId ?? null,
      event.availableAt ?? null,
    ],
  );
}

export type StoredEvent = {
  id: number;
  company_id: string;
  type: DomainEventType;
  version: number;
  payload: Record<string, unknown>;
  actor_id: string | null;
  correlation_id: string | null;
  attempts: number;
};

/**
 * How long a claim is honoured before another worker may take the row back.
 *
 * Long enough that a slow delivery is never stolen mid-flight, short enough that a worker
 * killed by a deploy does not strand its batch until someone notices.
 */
const CLAIM_TTL_MINUTES = 5;

/**
 * Claims a batch of due events for this worker.
 *
 * The obvious spelling is SELECT ... FOR UPDATE SKIP LOCKED, but that needs MySQL 8.0 or
 * MariaDB 10.6, and this has to run on whatever database the deployment already has. A
 * claim token needs nothing beyond an UPDATE with a LIMIT.
 *
 * It is also the better mechanism. SKIP LOCKED holds its locks only until the transaction
 * commits, so a worker that crashed after claiming rows left them looking free while its
 * delivery might still have been in flight - two workers, one event, no way to tell. A
 * token with a staleness window says who holds a row and for how long, so a crashed
 * worker's batch is reclaimed on a known schedule rather than immediately or never.
 */
export async function claimBatch(limit: number): Promise<StoredEvent[]> {
  const token = randomUUID();

  // A single UPDATE is the claim. Whichever worker's statement lands first owns the rows;
  // the other simply matches fewer, with no lock contention between them.
  const claimed = await pool.query(
    `UPDATE outbox_events
        SET locked_at = NOW(3), lock_token = $1, attempts = attempts + 1
      WHERE processed_at IS NULL
        AND available_at <= NOW(3)
        AND (locked_at IS NULL OR locked_at < DATE_SUB(NOW(3), INTERVAL ${CLAIM_TTL_MINUTES} MINUTE))
      ORDER BY id
      LIMIT $2`,
    [token, limit],
  );
  if ((claimed.rowCount ?? 0) === 0) return [];

  const rows = await pool.query<StoredEvent>(
    `SELECT id, company_id, type, version, payload, actor_id, correlation_id, attempts
       FROM outbox_events WHERE lock_token = $1 ORDER BY id`,
    [token],
  );
  return rows.rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }));
}

/** JSON columns arrive as a string or an object depending on driver version. */
function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (value as Record<string, unknown>) ?? {};
}

export async function markProcessed(id: number): Promise<void> {
  await pool.query(
    'UPDATE outbox_events SET processed_at = NOW(3), locked_at = NULL, lock_token = NULL WHERE id = $1',
    [id],
  );
}

/** Exponential backoff; exhausted events go to the dead-letter table for inspection. */
export async function markFailed(
  event: StoredEvent,
  error: string,
  maxAttempts: number,
): Promise<void> {
  if (event.attempts >= maxAttempts) {
    await pool.query(`INSERT INTO dead_letters (source, payload, error) VALUES ($1,$2,$3)`, [
      'outbox',
      JSON.stringify(event),
      error.slice(0, 2000),
    ]);
    await pool.query(
      `UPDATE outbox_events SET processed_at = NOW(3), locked_at = NULL, lock_token = NULL, last_error = $2 WHERE id = $1`,
      [event.id, error.slice(0, 2000)],
    );
    return;
  }
  const backoffSeconds = Math.min(2 ** event.attempts, 300);
  await pool.query(
    `UPDATE outbox_events
        SET locked_at = NULL,
            lock_token = NULL,
            last_error = $2,
            available_at = DATE_ADD(NOW(3), INTERVAL $3 SECOND)
      WHERE id = $1`,
    [event.id, error.slice(0, 2000), backoffSeconds],
  );
}
