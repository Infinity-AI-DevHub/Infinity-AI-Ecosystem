/**
 * Transactional outbox (blueprint 06). Domain code emits events inside the same
 * transaction as the state change; the dispatcher publishes them afterwards, so the
 * database and the event stream cannot diverge.
 */
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
 * Claims a batch of due events using SKIP LOCKED so multiple worker instances can run
 * concurrently without processing the same event twice.
 *
 * MySQL offers neither UPDATE ... RETURNING nor a self-referencing subquery in UPDATE,
 * so the claim is a select-then-update inside one transaction. The row locks taken by
 * SELECT ... FOR UPDATE SKIP LOCKED are held until commit, which is what stops a second
 * worker claiming the same rows in the window between the two statements.
 */
export async function claimBatch(limit: number): Promise<StoredEvent[]> {
  return transaction(async (tx) => {
    const claimed = await tx.query<{ id: number }>(
      `SELECT id FROM outbox_events
        WHERE processed_at IS NULL AND available_at <= NOW(3)
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const ids = claimed.rows.map((row) => row.id);
    if (ids.length === 0) return [];

    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
    await tx.query(
      `UPDATE outbox_events SET locked_at = NOW(3), attempts = attempts + 1
        WHERE id IN (${placeholders})`,
      ids,
    );
    const rows = await tx.query<StoredEvent>(
      `SELECT id, company_id, type, version, payload, actor_id, correlation_id, attempts
         FROM outbox_events WHERE id IN (${placeholders}) ORDER BY id`,
      ids,
    );
    return rows.rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }));
  });
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
    'UPDATE outbox_events SET processed_at = NOW(3), locked_at = NULL WHERE id = $1',
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
      `UPDATE outbox_events SET processed_at = NOW(3), locked_at = NULL, last_error = $2 WHERE id = $1`,
      [event.id, error.slice(0, 2000)],
    );
    return;
  }
  const backoffSeconds = Math.min(2 ** event.attempts, 300);
  await pool.query(
    `UPDATE outbox_events
        SET locked_at = NULL,
            last_error = $2,
            available_at = DATE_ADD(NOW(3), INTERVAL $3 SECOND)
      WHERE id = $1`,
    [event.id, error.slice(0, 2000), backoffSeconds],
  );
}
