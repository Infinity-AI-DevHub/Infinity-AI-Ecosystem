/**
 * Change management.
 *
 * A change moves through draft → approval → schedule → implementation → closure, and
 * approval is not reimplemented here: a submitted change raises an ordinary request on
 * the approvals engine under the `change` definition, so delegation, escalation, the
 * approvals queue and separation of duties all apply unchanged. The request's amount is
 * the risk score (1 low, 2 medium, 3 high), which is what lets one routing table send a
 * high-risk change to an administrator as well as the requester's manager.
 *
 * Standard changes are the exception by definition: routine, pre-approved work. They go
 * straight to approved on submission, and the audit trail records that they did.
 *
 * Every employee who can raise a change can read every change - a change calendar that
 * hides planned outages from the people affected by them defeats its purpose.
 */
import { many, newId, one, pool, transaction, type Queryable } from '../core/db.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import * as notifications from './notifications.js';
import * as searchIndex from './search.js';

export type ChangeStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'scheduled' | 'in_progress' | 'implemented' | 'failed' | 'cancelled' | 'closed';
type Risk = 'low' | 'medium' | 'high';

const RISK_SCORE: Record<Risk, number> = { low: 1, medium: 2, high: 3 };

/** The approval route new companies get, and existing ones get on first use. */
export const CHANGE_APPROVAL_DEFINITION = {
  key: 'change',
  name: 'Change request',
  formSchema: [
    { field: 'risk', label: 'Risk', type: 'select', options: ['low', 'medium', 'high'] },
    { field: 'plannedStart', label: 'Planned start', type: 'datetime' },
  ],
  routing: [
    { step: 1, approver: { type: 'manager', fallback: { type: 'access_level', value: 'admin' } }, dueHours: 48 },
    // Amount carries the risk score: only high-risk changes reach this step.
    { step: 2, minAmount: 3, approver: { type: 'access_level', value: 'admin' }, dueHours: 48 },
  ],
};

type ChangeRow = {
  id: string; company_id: string; number: number; title: string; description: string;
  change_type: 'standard' | 'normal' | 'emergency'; risk: Risk; impact: string | null;
  implementation_plan: string | null; rollback_plan: string | null; test_plan: string | null;
  status: ChangeStatus; requester_id: string; owner_id: string | null; queue_id: string | null;
  planned_start: Date | null; planned_end: Date | null; implemented_at: Date | null;
  outcome: string | null; outcome_notes: string | null; approval_request_id: string | null;
  version: number; created_at: Date; updated_at: Date;
};

export const changeRef = (n: number) => `CHG-${n}`;

function requireEmployee(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
}

async function load(actor: Actor, id: string, db: Queryable = pool): Promise<ChangeRow> {
  requireEmployee(actor);
  await authorize({ actor, capability: 'change.create', resourceless: true });
  const res = await db.query<ChangeRow>('SELECT * FROM change_requests WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!res.rows[0]) throw notFound('Change not found');
  return res.rows[0];
}

/** Requester and owner steer their own change; change.manage steers any. */
function canSteer(actor: Actor, c: ChangeRow): boolean {
  return hasCapability(actor, 'change.manage') || c.requester_id === actor.userId || c.owner_id === actor.userId;
}

async function event(db: Queryable, c: ChangeRow, actorId: string | null, kind: string, detail: string | null = null) {
  await db.query('INSERT INTO change_events (change_id, company_id, actor_id, kind, detail) VALUES ($1,$2,$3,$4,$5)',
    [c.id, c.company_id, actorId, kind, detail?.slice(0, 500) ?? null]);
}

async function index(c: ChangeRow) {
  await searchIndex.index({
    companyId: c.company_id, docType: 'change', resourceId: c.id,
    title: `${changeRef(c.number)} ${c.title}`, body: `${c.description} ${c.impact ?? ''}`,
    aclCompanyWide: true, link: `/service/changes/${c.id}`,
  });
}

export async function listChanges(actor: Actor, filter: { status?: ChangeStatus | 'upcoming' | 'open'; limit: number }) {
  requireEmployee(actor);
  await authorize({ actor, capability: 'change.create', resourceless: true });
  const where = ['c.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  if (filter.status === 'upcoming') where.push("c.status IN ('approved','scheduled','in_progress') AND (c.planned_end IS NULL OR c.planned_end >= NOW(3))");
  else if (filter.status === 'open') where.push("c.status NOT IN ('closed','cancelled','rejected')");
  else if (filter.status) { params.push(filter.status); where.push(`c.status = $${params.length}`); }
  params.push(filter.limit);
  const rows = await many<ChangeRow & { requester_name: string; owner_name: string | null }>(
    `SELECT c.*, r.display_name AS requester_name, o.display_name AS owner_name
       FROM change_requests c JOIN users r ON r.id = c.requester_id LEFT JOIN users o ON o.id = c.owner_id
      WHERE ${where.join(' AND ')}
      ORDER BY (c.planned_start IS NULL), c.planned_start, c.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return { items: rows.map((c) => ({ ...summary(c), requesterName: c.requester_name, ownerName: c.owner_name })) };
}

function summary(c: ChangeRow) {
  return {
    id: c.id, number: c.number, ref: changeRef(c.number), title: c.title, changeType: c.change_type, risk: c.risk,
    status: c.status, requesterId: c.requester_id, ownerId: c.owner_id, queueId: c.queue_id,
    plannedStart: c.planned_start, plannedEnd: c.planned_end, implementedAt: c.implemented_at, outcome: c.outcome,
    createdAt: c.created_at, updatedAt: c.updated_at, version: c.version,
  };
}

export async function getChange(actor: Actor, id: string) {
  const c = await load(actor, id);
  const names = await one<{ requester_name: string; owner_name: string | null; queue_name: string | null; approval_status: string | null; approval_reference: string | null }>(
    `SELECT r.display_name AS requester_name, o.display_name AS owner_name, q.name AS queue_name,
            ar.status AS approval_status, ar.reference AS approval_reference
       FROM change_requests c JOIN users r ON r.id = c.requester_id
       LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN service_queues q ON q.id = c.queue_id
       LEFT JOIN approval_requests ar ON ar.id = c.approval_request_id
      WHERE c.id = $1`, [id]);
  const tickets = await many<{ id: string; number: number; subject: string; status: string; type: string }>(
    `SELECT t.id, t.number, t.subject, t.status, t.type FROM change_ticket_links l JOIN tickets t ON t.id = l.ticket_id
      WHERE l.change_id = $1 ORDER BY l.linked_at`, [id]);
  const events = await many<{ id: number; kind: string; detail: string | null; created_at: Date; actor_name: string | null }>(
    `SELECT e.id, e.kind, e.detail, e.created_at, u.display_name AS actor_name
       FROM change_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.change_id = $1 ORDER BY e.id`, [id]);
  const steer = canSteer(actor, c);
  return {
    ...summary(c),
    description: c.description, impact: c.impact, implementationPlan: c.implementation_plan,
    rollbackPlan: c.rollback_plan, testPlan: c.test_plan, outcomeNotes: c.outcome_notes,
    requesterName: names?.requester_name ?? null, ownerName: names?.owner_name ?? null, queueName: names?.queue_name ?? null,
    approval: c.approval_request_id ? { id: c.approval_request_id, status: names?.approval_status ?? null, reference: names?.approval_reference ?? null } : null,
    tickets: tickets.map((t) => ({ id: t.id, ref: `SD-${t.number}`, subject: t.subject, status: t.status, type: t.type })),
    events: events.map((e) => ({ id: Number(e.id), kind: e.kind, detail: e.detail, createdAt: e.created_at, actorName: e.actor_name })),
    permissions: {
      canEdit: steer && (c.status === 'draft' || c.status === 'rejected'),
      canSubmit: steer && (c.status === 'draft' || c.status === 'rejected'),
      canSchedule: steer && (c.status === 'approved' || c.status === 'scheduled'),
      canStart: steer && (c.status === 'approved' || c.status === 'scheduled'),
      canComplete: steer && c.status === 'in_progress',
      canClose: steer && (c.status === 'implemented' || c.status === 'failed'),
      canCancel: steer && !['implemented', 'failed', 'cancelled', 'closed', 'in_progress'].includes(c.status),
      canLink: steer,
    },
  };
}

type ChangeInput = {
  title: string; description: string; changeType?: 'standard' | 'normal' | 'emergency'; risk?: Risk;
  impact?: string | null; implementationPlan?: string | null; rollbackPlan?: string | null; testPlan?: string | null;
  ownerId?: string | null; queueId?: string | null; plannedStart?: string | null; plannedEnd?: string | null;
};

async function assertRefs(companyId: string, input: Partial<ChangeInput>) {
  if (input.ownerId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active' AND access_level <> 'guest'", [input.ownerId, companyId]))) {
    throw unprocessable('Owner not found', [{ field: 'ownerId', message: 'Choose an active employee' }]);
  }
  if (input.queueId && !(await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2', [input.queueId, companyId]))) {
    throw unprocessable('Queue not found', [{ field: 'queueId', message: 'Choose a queue' }]);
  }
  if (input.plannedStart && input.plannedEnd && new Date(input.plannedEnd) < new Date(input.plannedStart)) {
    throw unprocessable('The window ends before it starts', [{ field: 'plannedEnd', message: 'End after the start' }]);
  }
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);

export async function createChange(actor: Actor, input: ChangeInput) {
  requireEmployee(actor);
  await authorize({ actor, capability: 'change.create', resourceless: true });
  await assertRefs(actor.companyId, input);
  const id = await transaction(async (tx) => {
    await tx.query('INSERT IGNORE INTO change_counters (company_id, next_number) VALUES ($1, 1)', [actor.companyId]);
    const counter = await tx.query<{ next_number: number }>('SELECT next_number FROM change_counters WHERE company_id = $1 FOR UPDATE', [actor.companyId]);
    const number = Number(counter.rows[0]!.next_number);
    await tx.query('UPDATE change_counters SET next_number = next_number + 1 WHERE company_id = $1', [actor.companyId]);
    const changeId = newId();
    await tx.query(
      `INSERT INTO change_requests (id, company_id, number, title, description, change_type, risk, impact,
         implementation_plan, rollback_plan, test_plan, requester_id, owner_id, queue_id, planned_start, planned_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [changeId, actor.companyId, number, input.title.trim(), input.description.trim(), input.changeType ?? 'normal', input.risk ?? 'medium',
        input.impact?.trim() || null, input.implementationPlan?.trim() || null, input.rollbackPlan?.trim() || null, input.testPlan?.trim() || null,
        actor.userId, input.ownerId ?? actor.userId, input.queueId ?? null, toDate(input.plannedStart), toDate(input.plannedEnd)],
    );
    const row = (await tx.query<ChangeRow>('SELECT * FROM change_requests WHERE id = $1', [changeId])).rows[0]!;
    await event(tx, row, actor.userId, 'created');
    await auditFromActor(actor, 'change.create', { resourceType: 'change_request', resourceId: changeId, metadata: { number, risk: row.risk, type: row.change_type } }, tx);
    return changeId;
  });
  await index((await one<ChangeRow>('SELECT * FROM change_requests WHERE id = $1', [id]))!);
  return getChange(actor, id);
}

export async function updateChange(actor: Actor, id: string, input: Partial<ChangeInput>, expectedVersion?: number) {
  const c = await load(actor, id);
  if (!canSteer(actor, c)) throw forbidden('Only the requester, the owner or a change manager can edit this change');
  const planningOnly = Object.keys(input).every((k) => ['plannedStart', 'plannedEnd', 'ownerId'].includes(k));
  if (!(c.status === 'draft' || c.status === 'rejected') && !(planningOnly && ['approved', 'scheduled'].includes(c.status))) {
    throw conflict('An approved change can only be rescheduled or reassigned. Anything else needs a new change.');
  }
  if (expectedVersion !== undefined && expectedVersion !== c.version) throw preconditionFailed('This change was edited since you opened it. Reload to see the latest.');
  await assertRefs(actor.companyId, {
    ...input,
    plannedStart: input.plannedStart !== undefined ? input.plannedStart : c.planned_start?.toISOString(),
    plannedEnd: input.plannedEnd !== undefined ? input.plannedEnd : c.planned_end?.toISOString(),
  });
  const pick = <T,>(key: keyof ChangeInput, current: T) => (input[key] !== undefined ? input[key] : current);
  await transaction(async (tx) => {
    const res = await tx.query(
      `UPDATE change_requests SET title = $3, description = $4, change_type = $5, risk = $6, impact = $7,
         implementation_plan = $8, rollback_plan = $9, test_plan = $10, owner_id = $11, queue_id = $12,
         planned_start = $13, planned_end = $14, version = version + 1
       WHERE id = $1 AND company_id = $2 AND version = $15`,
      [id, actor.companyId, String(pick('title', c.title)).trim(), String(pick('description', c.description)).trim(),
        pick('changeType', c.change_type), pick('risk', c.risk), pick('impact', c.impact), pick('implementationPlan', c.implementation_plan),
        pick('rollbackPlan', c.rollback_plan), pick('testPlan', c.test_plan), pick('ownerId', c.owner_id), pick('queueId', c.queue_id),
        input.plannedStart !== undefined ? toDate(input.plannedStart) : c.planned_start,
        input.plannedEnd !== undefined ? toDate(input.plannedEnd) : c.planned_end, c.version],
    );
    if (res.rowCount === 0) throw preconditionFailed('This change was edited since you opened it. Reload to see the latest.');
    await event(tx, c, actor.userId, planningOnly && c.status !== 'draft' ? 'rescheduled' : 'edited', Object.keys(input).join(', '));
    await auditFromActor(actor, 'change.update', { resourceType: 'change_request', resourceId: id, metadata: { changes: Object.keys(input) } }, tx);
  });
  await index((await one<ChangeRow>('SELECT * FROM change_requests WHERE id = $1', [id]))!);
  return getChange(actor, id);
}

async function ensureDefinition(companyId: string) {
  await pool.query(
    `INSERT IGNORE INTO approval_definitions (id, company_id, \`key\`, name, form_schema, routing)
     VALUES ($1,$2,'change',$3,$4,$5)`,
    [newId(), companyId, CHANGE_APPROVAL_DEFINITION.name, JSON.stringify(CHANGE_APPROVAL_DEFINITION.formSchema), JSON.stringify(CHANGE_APPROVAL_DEFINITION.routing)],
  );
}

export async function submitChange(actor: Actor, id: string, correlationId: string) {
  const c = await load(actor, id);
  if (!canSteer(actor, c)) throw forbidden('Only the requester, the owner or a change manager can submit this change');
  if (c.status !== 'draft' && c.status !== 'rejected') throw conflict('This change has already been submitted');
  const missing = [
    !c.implementation_plan && 'an implementation plan',
    !c.rollback_plan && 'a rollback plan',
    !c.planned_start && 'a planned start',
  ].filter(Boolean) as string[];
  if (missing.length && c.change_type !== 'standard') {
    throw unprocessable(`Add ${missing.join(', ')} before submitting`, missing.map((m) => ({ field: m, message: `Add ${m}` })));
  }

  if (c.change_type === 'standard') {
    await transaction(async (tx) => {
      await tx.query("UPDATE change_requests SET status = 'approved', version = version + 1 WHERE id = $1", [id]);
      await event(tx, c, actor.userId, 'approved', 'Standard change: pre-approved');
      await auditFromActor(actor, 'change.approved_standard', { resourceType: 'change_request', resourceId: id }, tx);
    });
    return getChange(actor, id);
  }

  await ensureDefinition(actor.companyId);
  const { createRequest } = await import('./approvals.js');
  let request;
  try {
    request = await createRequest(actor, {
      definitionKey: 'change',
      title: `${changeRef(c.number)}: ${c.title}`.slice(0, 200),
      amount: RISK_SCORE[c.risk],
      data: { changeId: c.id, risk: c.risk, changeType: c.change_type, plannedStart: c.planned_start },
    }, correlationId);
  } catch (err) {
    // The engine's wording is about request types in general; say what it means here.
    if ((err as { statusCode?: number }).statusCode === 422 && /cannot be routed/.test((err as Error).message)) {
      throw unprocessable(
        c.risk === 'high'
          ? 'Nobody can approve this change yet. It needs your manager (or an active administrator if you have none) and an active administrator who is not you.'
          : 'Nobody can approve this change yet. It needs your manager, or an active administrator if you have none, who is not you.',
        [{ field: 'approval', message: 'Set a manager on your profile in People, or activate an administrator account.' }],
      );
    }
    throw err;
  }
  await transaction(async (tx) => {
    await tx.query("UPDATE change_requests SET status = 'pending_approval', approval_request_id = $2, version = version + 1 WHERE id = $1", [id, request.id]);
    await event(tx, c, actor.userId, 'submitted', request.reference);
    await auditFromActor(actor, 'change.submit', { resourceType: 'change_request', resourceId: id, metadata: { approvalRequestId: request.id } }, tx);
  });
  return getChange(actor, id);
}

/** Called by the outbox when the approval behind a change completes. */
export async function settleDecision(changeId: string, status: 'approved' | 'rejected') {
  const c = await one<ChangeRow>('SELECT * FROM change_requests WHERE id = $1', [changeId]);
  if (!c || c.status !== 'pending_approval') return;
  await pool.query('UPDATE change_requests SET status = $2, version = version + 1 WHERE id = $1', [changeId, status]);
  await event(pool, c, null, status);
  await notifications.create({
    companyId: c.company_id, userId: c.requester_id, type: status === 'approved' ? 'change.approved' : 'change.rejected',
    title: `${changeRef(c.number)} was ${status}`, body: c.title, link: `/service/changes/${c.id}`,
    resourceType: 'change_request', resourceId: c.id, dedupeKey: `change-decision:${c.id}:${c.approval_request_id}`,
  });
}

type Transition = 'schedule' | 'start' | 'complete' | 'close' | 'cancel';

export async function transition(actor: Actor, id: string, action: Transition, input: { plannedStart?: string; plannedEnd?: string; outcome?: 'successful' | 'failed' | 'rolled_back'; notes?: string | null }) {
  const c = await load(actor, id);
  if (!canSteer(actor, c)) throw forbidden('Only the requester, the owner or a change manager can do that');
  const allowed: Record<Transition, ChangeStatus[]> = {
    schedule: ['approved', 'scheduled'],
    start: ['approved', 'scheduled'],
    complete: ['in_progress'],
    close: ['implemented', 'failed'],
    cancel: ['draft', 'pending_approval', 'approved', 'rejected', 'scheduled'],
  };
  if (!allowed[action].includes(c.status)) throw conflict(`A change that is ${c.status.replace('_', ' ')} cannot be ${action === 'start' ? 'started' : `${action}d`}`);

  let next: ChangeStatus = c.status;
  const sets: string[] = [];
  const params: unknown[] = [id];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (action === 'schedule') {
    if (!input.plannedStart) throw unprocessable('Choose when the change starts', [{ field: 'plannedStart', message: 'Required' }]);
    await assertRefs(actor.companyId, { plannedStart: input.plannedStart, plannedEnd: input.plannedEnd ?? null });
    next = 'scheduled';
    sets.push(`planned_start = ${p(new Date(input.plannedStart))}`, `planned_end = ${p(toDate(input.plannedEnd))}`);
  } else if (action === 'start') {
    next = 'in_progress';
  } else if (action === 'complete') {
    if (!input.outcome) throw unprocessable('Record how the change went', [{ field: 'outcome', message: 'Required' }]);
    next = input.outcome === 'successful' ? 'implemented' : 'failed';
    sets.push('implemented_at = NOW(3)', `outcome = ${p(input.outcome)}`, `outcome_notes = ${p(input.notes?.trim() || null)}`);
  } else if (action === 'close') {
    next = 'closed';
  } else {
    next = 'cancelled';
  }
  sets.push(`status = ${p(next)}`, 'version = version + 1');
  await transaction(async (tx) => {
    await tx.query(`UPDATE change_requests SET ${sets.join(', ')} WHERE id = $1`, params);
    await event(tx, c, actor.userId, action, action === 'complete' ? input.outcome ?? null : action === 'schedule' ? input.plannedStart ?? null : null);
    await auditFromActor(actor, `change.${action}`, { resourceType: 'change_request', resourceId: id, metadata: { from: c.status, to: next } }, tx);
  });
  // An approval still waiting on a cancelled change is withdrawn, so nobody decides a dead request.
  if (action === 'cancel' && c.status === 'pending_approval' && c.approval_request_id) {
    const request = await one<{ requester_id: string; status: string }>('SELECT requester_id, status FROM approval_requests WHERE id = $1', [c.approval_request_id]);
    if (request?.status === 'pending') {
      if (request.requester_id === actor.userId) {
        const { cancelRequest } = await import('./approvals.js');
        await cancelRequest(actor, c.approval_request_id);
      } else {
        // A change manager withdrawing someone else's change: same effect as the engine's
        // own cancellation, recorded against the person who did it.
        await transaction(async (tx) => {
          await tx.query("UPDATE approval_requests SET status = 'cancelled', version = version + 1, updated_at = NOW(3) WHERE id = $1 AND status = 'pending'", [c.approval_request_id]);
          await tx.query("UPDATE approval_steps SET state = 'skipped' WHERE request_id = $1 AND state <> 'done'", [c.approval_request_id]);
          await auditFromActor(actor, 'approval.cancel', { resourceType: 'approval_request', resourceId: c.approval_request_id!, metadata: { reason: 'change cancelled', changeId: c.id } }, tx);
        });
      }
    }
  }
  return getChange(actor, id);
}

export async function linkTicket(actor: Actor, id: string, ticketId: string, remove = false) {
  const c = await load(actor, id);
  if (!canSteer(actor, c)) throw forbidden('Only the requester, the owner or a change manager can link tickets');
  const { assertWorker } = await import('./service.js');
  await assertWorker(actor, ticketId);
  const t = await one<{ number: number }>('SELECT number FROM tickets WHERE id = $1', [ticketId]);
  if (remove) await pool.query('DELETE FROM change_ticket_links WHERE change_id = $1 AND ticket_id = $2', [id, ticketId]);
  else await pool.query('INSERT IGNORE INTO change_ticket_links (change_id, ticket_id, linked_by) VALUES ($1,$2,$3)', [id, ticketId, actor.userId]);
  await event(pool, c, actor.userId, remove ? 'ticket_unlinked' : 'ticket_linked', `SD-${t?.number}`);
  await auditFromActor(actor, remove ? 'change.ticket.unlink' : 'change.ticket.link', { resourceType: 'change_request', resourceId: id, metadata: { ticketId } });
  return getChange(actor, id);
}
