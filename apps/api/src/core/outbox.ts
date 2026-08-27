/**
 * Transactional outbox (blueprint 06). Domain code emits events inside the same
 * transaction as the state change; the dispatcher publishes them afterwards, so the
 * database and the event stream cannot diverge.
 */
import { pool, type Queryable } from './db.js';

export type DomainEventType =
  | 'user.invited'
  | 'user.activated'
  | 'user.updated'
  | 'user.suspended'
  | 'user.reactivated'
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
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, now()))`,
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
 */
export async function claimBatch(limit: number): Promise<StoredEvent[]> {
  const res = await pool.query<StoredEvent>(
    `UPDATE outbox_events SET locked_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE processed_at IS NULL AND available_at <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id, company_id, type, version, payload, actor_id, correlation_id, attempts`,
    [limit],
  );
  return res.rows;
}

export async function markProcessed(id: number): Promise<void> {
  await pool.query('UPDATE outbox_events SET processed_at = now(), locked_at = NULL WHERE id = $1', [
    id,
  ]);
}

/** Exponential backoff; exhausted events go to the dead-letter table for inspection. */
export async function markFailed(
  event: StoredEvent,
  error: string,
  maxAttempts: number,
): Promise<void> {
  if (event.attempts >= maxAttempts) {
    await pool.query(
      `INSERT INTO dead_letters (source, payload, error) VALUES ($1,$2,$3)`,
      ['outbox', JSON.stringify(event), error.slice(0, 2000)],
    );
    await pool.query(
      `UPDATE outbox_events SET processed_at = now(), locked_at = NULL, last_error = $2 WHERE id = $1`,
      [event.id, error.slice(0, 2000)],
    );
    return;
  }
  const backoffSeconds = Math.min(2 ** event.attempts, 300);
  await pool.query(
    `UPDATE outbox_events
        SET locked_at = NULL,
            last_error = $2,
            available_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1`,
    [event.id, error.slice(0, 2000), backoffSeconds],
  );
}
