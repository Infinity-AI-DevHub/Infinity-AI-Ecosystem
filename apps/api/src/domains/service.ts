/**
 * Service desk: queues, tickets, SLA targets, the conversation and its timeline.
 *
 * Who sees what is the whole design, so it is stated once here and every function below
 * goes through `access()`:
 *
 *   requester   the person who raised it. Sees the ticket, public replies and public
 *               attachments; may reply publicly, close or reopen it, and rate it.
 *   client      a guest whose organisation the ticket belongs to. Same as a requester,
 *               for every ticket of their organisation, and nothing else in the desk.
 *   worker      a member of the ticket's queue, or anyone holding `ticket.work`. Sees
 *               everything including internal notes; changes status, priority,
 *               assignment and queue.
 *   overseer    `ticket.read`. Sees every ticket, internal notes included, read-only
 *               unless also a worker.
 *
 * Anyone else is told the ticket does not exist rather than that it is forbidden, so a
 * ticket number cannot be probed.
 *
 * SLA targets are wall-clock minutes from creation, one pair per priority. Business hours
 * and pausing while waiting on the requester are not modelled; the settings screen says
 * so rather than implying otherwise.
 */
import { many, newId, one, pool, transaction, type Queryable } from '../core/db.js';
import { badRequest, conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { publishToUser } from '../core/realtime.js';
import { decodeCursor, encodeCursor } from '../core/validation.js';
import { addBusinessMinutes, businessMinutesBetween, DEFAULT_SCHEDULE, isValidTimezone, type Schedule } from '../core/business-hours.js';
import * as notifications from './notifications.js';
import * as searchIndex from './search.js';

export type TicketStatus = 'new' | 'open' | 'pending' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketType = 'incident' | 'request' | 'question' | 'problem';

export const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Used until an administrator sets the company's own targets. */
export const DEFAULT_SLA: Record<TicketPriority, { firstResponse: number; resolution: number }> = {
  urgent: { firstResponse: 30, resolution: 240 },
  high: { firstResponse: 60, resolution: 480 },
  normal: { firstResponse: 240, resolution: 1440 },
  low: { firstResponse: 480, resolution: 4320 },
};

export function ticketRef(number: number): string {
  return `SD-${number}`;
}

type TicketRow = {
  id: string;
  company_id: string;
  number: number;
  subject: string;
  description: string;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  channel: string;
  queue_id: string;
  category_id: string | null;
  requester_id: string;
  client_org_id: string | null;
  assignee_id: string | null;
  task_id: string | null;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  response_breached_at: Date | null;
  resolution_breached_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  form_answers: unknown;
  sla_paused_at: Date | null;
  sla_paused_minutes: number;
  root_cause: string | null;
  workaround: string | null;
};

/* ------------------------------------------------------------ request forms */

export type FormField = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  options?: string[];
  help?: string;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value as T;
}

/** A category's form definition, checked before it is stored so every ticket form renders. */
export function validateFormFields(fields: FormField[]): FormField[] {
  if (fields.length > 20) throw unprocessable('A request form can have at most 20 fields');
  const keys = new Set<string>();
  return fields.map((f, i) => {
    const key = f.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
    if (!key || keys.has(key)) throw unprocessable(`Field ${i + 1} needs a unique name`, [{ field: `fields.${i}.key`, message: 'Unique name required' }]);
    keys.add(key);
    if (!f.label.trim()) throw unprocessable(`Field ${i + 1} needs a label`, [{ field: `fields.${i}.label`, message: 'Label required' }]);
    const options = f.type === 'select' ? [...new Set((f.options ?? []).map((o) => o.trim()).filter(Boolean))].slice(0, 50) : undefined;
    if (f.type === 'select' && (!options || options.length < 2)) {
      throw unprocessable(`"${f.label}" needs at least two choices`, [{ field: `fields.${i}.options`, message: 'Add choices' }]);
    }
    return { key, label: f.label.trim().slice(0, 120), type: f.type, required: Boolean(f.required), ...(options ? { options } : {}), ...(f.help?.trim() ? { help: f.help.trim().slice(0, 200) } : {}) };
  });
}

/** Answers checked against the category's current form; unknown keys are dropped. */
function validateAnswers(fields: FormField[], answers: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const problems: { field: string; message: string }[] = [];
  for (const f of fields) {
    const raw = answers?.[f.key];
    const empty = raw === undefined || raw === null || raw === '' || (f.type === 'checkbox' && raw === false);
    if (empty) {
      if (f.required) problems.push({ field: `formAnswers.${f.key}`, message: `${f.label} is required` });
      continue;
    }
    if (f.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) { problems.push({ field: `formAnswers.${f.key}`, message: `${f.label} must be a number` }); continue; }
      out[f.key] = n;
    } else if (f.type === 'checkbox') {
      out[f.key] = raw === true || raw === 'true';
    } else if (f.type === 'date') {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) { problems.push({ field: `formAnswers.${f.key}`, message: `${f.label} must be a date` }); continue; }
      out[f.key] = raw;
    } else if (f.type === 'select') {
      if (!f.options?.includes(String(raw))) { problems.push({ field: `formAnswers.${f.key}`, message: `Choose one of the options for ${f.label}` }); continue; }
      out[f.key] = String(raw);
    } else {
      out[f.key] = String(raw).slice(0, f.type === 'textarea' ? 5000 : 500);
    }
  }
  if (problems.length) throw unprocessable(problems[0]!.message, problems);
  return out;
}

export async function setCategoryForm(actor: Actor, categoryId: string, fields: FormField[]) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const clean = validateFormFields(fields);
  const res = await pool.query('UPDATE service_categories SET form_fields = $3 WHERE id = $1 AND company_id = $2',
    [categoryId, actor.companyId, clean.length ? JSON.stringify(clean) : null]);
  if (res.rowCount === 0) throw notFound('Category not found');
  await auditFromActor(actor, 'service.category.form', { resourceType: 'service_category', resourceId: categoryId, metadata: { fields: clean.length } });
  return { fields: clean };
}

/* ------------------------------------------------------------------ access */

const guestView = (actor: Actor) => actor.accessLevel === 'guest';

async function memberQueueIds(actor: Actor, db: Queryable = pool): Promise<string[]> {
  const rows = await db.query<{ queue_id: string }>(
    'SELECT queue_id FROM service_queue_members WHERE user_id = $1 AND company_id = $2',
    [actor.userId, actor.companyId],
  );
  return rows.rows.map((r) => r.queue_id);
}

/** The guest's own client organisation, or null for an employee. */
async function guestOrganisationId(actor: Actor): Promise<string | null> {
  if (actor.accessLevel !== 'guest') return null;
  const row = await one<{ organization_id: string }>(
    `SELECT m.organization_id FROM external_memberships m
       JOIN external_organizations o ON o.id = m.organization_id AND o.status = 'active'
      WHERE m.user_id = $1 AND m.company_id = $2
        AND (m.access_expires_at IS NULL OR m.access_expires_at > NOW(3))
      ORDER BY m.created_at LIMIT 1`,
    [actor.userId, actor.companyId],
  );
  return row?.organization_id ?? null;
}

type Access = { canView: boolean; canWork: boolean; seesInternal: boolean; isRequesterSide: boolean };

async function access(actor: Actor, ticket: TicketRow): Promise<Access> {
  if (actor.status !== 'active' || ticket.company_id !== actor.companyId) {
    return { canView: false, canWork: false, seesInternal: false, isRequesterSide: false };
  }
  if (actor.accessLevel === 'guest') {
    const org = await guestOrganisationId(actor);
    const mine = ticket.requester_id === actor.userId || (org !== null && ticket.client_org_id === org);
    return { canView: mine, canWork: false, seesInternal: false, isRequesterSide: mine };
  }
  const worker = hasCapability(actor, 'ticket.work')
    || (await memberQueueIds(actor)).includes(ticket.queue_id);
  const overseer = hasCapability(actor, 'ticket.read');
  const requester = ticket.requester_id === actor.userId;
  return {
    canView: worker || overseer || requester,
    canWork: worker,
    seesInternal: worker || overseer,
    isRequesterSide: requester,
  };
}

async function loadTicket(actor: Actor, id: string, db: Queryable = pool): Promise<{ ticket: TicketRow; access: Access }> {
  const res = await db.query<TicketRow>('SELECT * FROM tickets WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  const ticket = res.rows[0];
  if (!ticket) throw notFound('Ticket not found');
  const acc = await access(actor, ticket);
  if (!acc.canView) throw notFound('Ticket not found');
  return { ticket, access: acc };
}

async function requireWorker(actor: Actor, id: string, db: Queryable = pool) {
  const loaded = await loadTicket(actor, id, db);
  if (!loaded.access.canWork) throw forbidden('Only people working this queue can do that');
  return loaded;
}

/** Is this person someone a ticket in this queue may be assigned to? */
async function assertAssignable(companyId: string, queueId: string, userId: string): Promise<void> {
  const row = await one<{ ok: number }>(
    `SELECT 1 AS ok FROM users u
      WHERE u.id = $1 AND u.company_id = $2 AND u.status = 'active' AND u.access_level <> 'guest'
        AND (
          EXISTS (SELECT 1 FROM service_queue_members m WHERE m.queue_id = $3 AND m.user_id = u.id)
          OR EXISTS (SELECT 1 FROM role_capabilities rc WHERE rc.role = u.access_level AND rc.capability = 'ticket.work')
        )`,
    [userId, companyId, queueId],
  );
  if (!row) throw unprocessable('That person does not work this queue', [{ field: 'assigneeId', message: 'Add them to the queue first' }]);
}

async function recordEvent(
  db: Queryable, ticket: { id: string; company_id: string }, actorId: string | null,
  kind: string, from: string | null = null, to: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO ticket_events (ticket_id, company_id, actor_id, kind, from_value, to_value)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ticket.id, ticket.company_id, actorId, kind, from?.slice(0, 300) ?? null, to?.slice(0, 300) ?? null],
  );
}

/** Tells everyone who may see the ticket list that it changed; the client refetches. */
async function broadcastChange(ticket: { id: string; company_id: string; queue_id: string; requester_id: string; assignee_id: string | null }) {
  const members = await many<{ user_id: string }>('SELECT user_id FROM service_queue_members WHERE queue_id = $1', [ticket.queue_id]);
  const people = new Set([ticket.requester_id, ...(ticket.assignee_id ? [ticket.assignee_id] : []), ...members.map((m) => m.user_id)]);
  for (const userId of people) publishToUser(userId, 'ticket.updated', { id: ticket.id });
}

async function indexTicket(ticket: TicketRow): Promise<void> {
  await searchIndex.index({
    companyId: ticket.company_id,
    docType: 'ticket',
    resourceId: ticket.id,
    title: `${ticketRef(ticket.number)} ${ticket.subject}`,
    body: ticket.description,
    aclCompanyWide: true,
    link: `/service/tickets/${ticket.id}`,
  });
}

/* ------------------------------------------------------------ configuration */

export async function listQueues(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
  await authorize({ actor, capability: 'ticket.create', resourceless: true });
  const manage = hasCapability(actor, 'service.manage');
  const mine = await memberQueueIds(actor);
  const rows = await many<{
    id: string; name: string; description: string | null; audience: string; is_active: number;
    escalation_user_id: string | null; escalation_name: string | null; member_count: number; open_count: number;
  }>(
    `SELECT q.id, q.name, q.description, q.audience, q.is_active, q.escalation_user_id,
            eu.display_name AS escalation_name,
            (SELECT COUNT(*) FROM service_queue_members m WHERE m.queue_id = q.id) AS member_count,
            (SELECT COUNT(*) FROM tickets t WHERE t.queue_id = q.id AND t.status NOT IN ('resolved','closed')) AS open_count
       FROM service_queues q
       LEFT JOIN users eu ON eu.id = q.escalation_user_id
      WHERE q.company_id = $1 ${manage ? '' : 'AND q.is_active = 1'}
      ORDER BY q.name`,
    [actor.companyId],
  );
  const categories = await many<{ id: string; queue_id: string; name: string; is_active: number; form_fields: unknown }>(
    `SELECT id, queue_id, name, is_active, form_fields FROM service_categories WHERE company_id = $1 ${manage ? '' : 'AND is_active = 1'} ORDER BY name`,
    [actor.companyId],
  );
  return rows.map((q) => ({
    id: q.id,
    name: q.name,
    description: q.description,
    audience: q.audience,
    isActive: Boolean(q.is_active),
    escalationUserId: q.escalation_user_id,
    escalationName: q.escalation_name,
    memberCount: Number(q.member_count),
    openCount: Number(q.open_count),
    isMember: mine.includes(q.id),
    categories: categories.filter((c) => c.queue_id === q.id).map((c) => ({ id: c.id, name: c.name, isActive: Boolean(c.is_active), formFields: parseJson<FormField[]>(c.form_fields, []) })),
  }));
}

export async function createQueue(actor: Actor, input: { name: string; description?: string | null; audience?: 'internal' | 'client'; escalationUserId?: string | null }) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const name = input.name.trim();
  if (await one('SELECT 1 FROM service_queues WHERE company_id = $1 AND name = $2', [actor.companyId, name])) {
    throw conflict('A queue with that name already exists');
  }
  if (input.escalationUserId) await assertEmployee(actor.companyId, input.escalationUserId);
  const id = newId();
  await pool.query(
    `INSERT INTO service_queues (id, company_id, name, description, audience, escalation_user_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, actor.companyId, name, input.description?.trim() || null, input.audience ?? 'internal', input.escalationUserId ?? null, actor.userId],
  );
  await auditFromActor(actor, 'service.queue.create', { resourceType: 'service_queue', resourceId: id, metadata: { name } });
  return { id };
}

export async function updateQueue(actor: Actor, id: string, input: { name?: string; description?: string | null; audience?: 'internal' | 'client'; escalationUserId?: string | null; isActive?: boolean }) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const queue = await one<{ id: string }>('SELECT id FROM service_queues WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!queue) throw notFound('Queue not found');
  if (input.escalationUserId) await assertEmployee(actor.companyId, input.escalationUserId);
  if (input.name && await one('SELECT 1 FROM service_queues WHERE company_id = $1 AND name = $2 AND id <> $3', [actor.companyId, input.name.trim(), id])) {
    throw conflict('A queue with that name already exists');
  }
  await pool.query(
    `UPDATE service_queues SET
       name = COALESCE($3, name),
       description = CASE WHEN $4 THEN $5 ELSE description END,
       audience = COALESCE($6, audience),
       escalation_user_id = CASE WHEN $7 THEN $8 ELSE escalation_user_id END,
       is_active = COALESCE($9, is_active)
     WHERE id = $1 AND company_id = $2`,
    [
      id, actor.companyId, input.name?.trim() ?? null,
      input.description !== undefined, input.description?.trim() || null,
      input.audience ?? null,
      input.escalationUserId !== undefined, input.escalationUserId ?? null,
      input.isActive === undefined ? null : input.isActive,
    ],
  );
  await auditFromActor(actor, 'service.queue.update', { resourceType: 'service_queue', resourceId: id, metadata: { changes: Object.keys(input) } });
  return { id };
}

async function assertEmployee(companyId: string, userId: string): Promise<void> {
  const row = await one('SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = \'active\' AND access_level <> \'guest\'', [userId, companyId]);
  if (!row) throw unprocessable('That person is not an active employee here');
}

export async function listQueueMembers(actor: Actor, queueId: string) {
  if (actor.accessLevel === 'guest') throw forbidden();
  const queue = await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2', [queueId, actor.companyId]);
  if (!queue) throw notFound('Queue not found');
  // Anyone who can raise a ticket may see who works a queue, so they know who will answer.
  await authorize({ actor, capability: 'ticket.create', resourceless: true });
  return many<{ id: string; display_name: string; email: string; avatar_color: string }>(
    `SELECT u.id, u.display_name, u.email, u.avatar_color
       FROM service_queue_members m JOIN users u ON u.id = m.user_id
      WHERE m.queue_id = $1 AND m.company_id = $2 ORDER BY u.display_name`,
    [queueId, actor.companyId],
  );
}

/** Everyone a ticket in this queue may be assigned to: its members and desk-wide workers. */
export async function listAssignees(actor: Actor, queueId: string) {
  if (actor.accessLevel === 'guest') throw forbidden();
  const queue = await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2', [queueId, actor.companyId]);
  if (!queue) throw notFound('Queue not found');
  const worker = hasCapability(actor, 'ticket.work') || (await memberQueueIds(actor)).includes(queueId);
  if (!worker) throw forbidden('Only people working this queue can assign tickets');
  return many<{ id: string; display_name: string; email: string; is_member: number }>(
    `SELECT u.id, u.display_name, u.email,
            EXISTS (SELECT 1 FROM service_queue_members m WHERE m.queue_id = $1 AND m.user_id = u.id) AS is_member
       FROM users u
      WHERE u.company_id = $2 AND u.status = 'active' AND u.access_level <> 'guest'
        AND (EXISTS (SELECT 1 FROM service_queue_members m WHERE m.queue_id = $1 AND m.user_id = u.id)
             OR EXISTS (SELECT 1 FROM role_capabilities rc WHERE rc.role = u.access_level AND rc.capability = 'ticket.work'))
      ORDER BY is_member DESC, u.display_name`,
    [queueId, actor.companyId],
  );
}

export async function setQueueMembers(actor: Actor, queueId: string, userIds: string[]) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const queue = await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2', [queueId, actor.companyId]);
  if (!queue) throw notFound('Queue not found');
  const unique = [...new Set(userIds)];
  for (const userId of unique) await assertEmployee(actor.companyId, userId);
  await transaction(async (tx) => {
    await tx.query('DELETE FROM service_queue_members WHERE queue_id = $1 AND company_id = $2', [queueId, actor.companyId]);
    for (const userId of unique) {
      await tx.query('INSERT INTO service_queue_members (queue_id, user_id, company_id) VALUES ($1,$2,$3)', [queueId, userId, actor.companyId]);
    }
    await auditFromActor(actor, 'service.queue.members', { resourceType: 'service_queue', resourceId: queueId, metadata: { members: unique.length } }, tx);
  });
  return { members: unique.length };
}

export async function createCategory(actor: Actor, queueId: string, name: string) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const queue = await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2', [queueId, actor.companyId]);
  if (!queue) throw notFound('Queue not found');
  if (await one('SELECT 1 FROM service_categories WHERE queue_id = $1 AND name = $2', [queueId, name.trim()])) {
    throw conflict('That category already exists in this queue');
  }
  const id = newId();
  await pool.query('INSERT INTO service_categories (id, company_id, queue_id, name) VALUES ($1,$2,$3,$4)', [id, actor.companyId, queueId, name.trim()]);
  await auditFromActor(actor, 'service.category.create', { resourceType: 'service_category', resourceId: id, metadata: { name } });
  return { id };
}

export async function updateCategory(actor: Actor, id: string, input: { name?: string; isActive?: boolean }) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const res = await pool.query(
    'UPDATE service_categories SET name = COALESCE($3, name), is_active = COALESCE($4, is_active) WHERE id = $1 AND company_id = $2',
    [id, actor.companyId, input.name?.trim() ?? null, input.isActive === undefined ? null : input.isActive],
  );
  if (res.rowCount === 0) throw notFound('Category not found');
  await auditFromActor(actor, 'service.category.update', { resourceType: 'service_category', resourceId: id, metadata: { changes: Object.keys(input) } });
  return { id };
}

type Sla = { firstResponse: number; resolution: number; business: boolean };

async function slaFor(companyId: string, priority: TicketPriority, db: Queryable = pool): Promise<Sla> {
  const res = await db.query<{ first_response_minutes: number; resolution_minutes: number; use_business_hours: number }>(
    'SELECT first_response_minutes, resolution_minutes, use_business_hours FROM sla_policies WHERE company_id = $1 AND priority = $2',
    [companyId, priority],
  );
  const row = res.rows[0];
  return row
    ? { firstResponse: Number(row.first_response_minutes), resolution: Number(row.resolution_minutes), business: Boolean(row.use_business_hours) }
    : { ...DEFAULT_SLA[priority], business: false };
}

/* ------------------------------------------------------- service calendar */

export async function loadCalendar(companyId: string, db: Queryable = pool): Promise<Schedule> {
  const res = await db.query<{ timezone: string; schedule: unknown; holidays: unknown }>(
    'SELECT timezone, schedule, holidays FROM service_business_hours WHERE company_id = $1', [companyId]);
  const row = res.rows[0];
  if (!row) return DEFAULT_SCHEDULE;
  return {
    timezone: row.timezone,
    days: parseJson<Schedule['days']>(row.schedule, {}),
    holidays: parseJson<string[]>(row.holidays, []),
  };
}

/** `from` plus `minutes`, counted the way the policy counts them. */
async function dueFrom(companyId: string, from: Date, minutes: number, business: boolean): Promise<Date> {
  if (!business) return new Date(from.getTime() + minutes * 60_000);
  return addBusinessMinutes(from, minutes, await loadCalendar(companyId));
}

export async function getCalendar(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
  await authorize({ actor, capability: 'ticket.create', resourceless: true });
  const configured = Boolean(await one('SELECT 1 FROM service_business_hours WHERE company_id = $1', [actor.companyId]));
  return { ...(await loadCalendar(actor.companyId)), configured };
}

export async function setCalendar(actor: Actor, input: Schedule) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  if (!isValidTimezone(input.timezone)) throw unprocessable('Unknown timezone', [{ field: 'timezone', message: 'Use a name like Asia/Colombo' }]);
  const days: Schedule['days'] = {};
  for (const [key, value] of Object.entries(input.days)) {
    const day = Number(key);
    if (!value) continue;
    if (!(day >= 1 && day <= 7) || value[0] < 0 || value[1] > 1440 || value[1] <= value[0]) {
      throw unprocessable('Opening hours must end after they start, within one day', [{ field: `days.${key}`, message: 'Invalid hours' }]);
    }
    days[day as 1] = [Math.round(value[0]), Math.round(value[1])];
  }
  const holidays = [...new Set(input.holidays.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h)))].sort().slice(0, 366);
  await pool.query(
    `INSERT INTO service_business_hours (company_id, timezone, schedule, holidays, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON DUPLICATE KEY UPDATE timezone = VALUES(timezone), schedule = VALUES(schedule), holidays = VALUES(holidays), updated_by = VALUES(updated_by)`,
    [actor.companyId, input.timezone, JSON.stringify(days), JSON.stringify(holidays), actor.userId],
  );
  await auditFromActor(actor, 'service.calendar.update', { resourceType: 'service_business_hours', metadata: { timezone: input.timezone, openDays: Object.keys(days).length, holidays: holidays.length } });
  return getCalendar(actor);
}

export async function listSlaPolicies(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
  await authorize({ actor, capability: 'ticket.create', resourceless: true });
  const rows = await many<{ priority: TicketPriority; first_response_minutes: number; resolution_minutes: number; use_business_hours: number; updated_at: Date }>(
    'SELECT priority, first_response_minutes, resolution_minutes, use_business_hours, updated_at FROM sla_policies WHERE company_id = $1',
    [actor.companyId],
  );
  return PRIORITIES.map((priority) => {
    const row = rows.find((r) => r.priority === priority);
    return {
      priority,
      firstResponseMinutes: row ? Number(row.first_response_minutes) : DEFAULT_SLA[priority].firstResponse,
      resolutionMinutes: row ? Number(row.resolution_minutes) : DEFAULT_SLA[priority].resolution,
      useBusinessHours: row ? Boolean(row.use_business_hours) : false,
      isDefault: !row,
    };
  });
}

export async function setSlaPolicy(actor: Actor, priority: TicketPriority, input: { firstResponseMinutes: number; resolutionMinutes: number; useBusinessHours?: boolean }) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  if (input.resolutionMinutes < input.firstResponseMinutes) {
    throw unprocessable('Resolution cannot be due before the first response', [{ field: 'resolutionMinutes', message: 'Must be at least the first response target' }]);
  }
  await pool.query(
    `INSERT INTO sla_policies (id, company_id, priority, first_response_minutes, resolution_minutes, use_business_hours, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON DUPLICATE KEY UPDATE first_response_minutes = VALUES(first_response_minutes),
                             resolution_minutes = VALUES(resolution_minutes),
                             use_business_hours = VALUES(use_business_hours),
                             updated_by = VALUES(updated_by)`,
    [newId(), actor.companyId, priority, input.firstResponseMinutes, input.resolutionMinutes, Boolean(input.useBusinessHours), actor.userId],
  );
  await auditFromActor(actor, 'service.sla.update', { resourceType: 'sla_policy', metadata: { priority, ...input } });
  return { priority, ...input, useBusinessHours: Boolean(input.useBusinessHours) };
}

/**
 * Starts or ends the SLA pause as a ticket enters or leaves 'pending'.
 *
 * On resume the paused span is measured in the policy's kind of minutes and every target
 * not yet met moves out by it, and the running total is kept for later recalculation.
 * Called inside the same transaction as the status change.
 */
async function applyPause(tx: Queryable, ticketId: string, from: TicketStatus, to: TicketStatus): Promise<void> {
  if (from === to) return;
  if (to === 'pending') {
    await tx.query('UPDATE tickets SET sla_paused_at = COALESCE(sla_paused_at, NOW(3)) WHERE id = $1', [ticketId]);
    return;
  }
  if (from !== 'pending') return;
  const t = (await tx.query<TicketRow>('SELECT * FROM tickets WHERE id = $1', [ticketId])).rows[0];
  if (!t?.sla_paused_at) return;
  const sla = await slaFor(t.company_id, t.priority, tx);
  const now = new Date();
  const paused = sla.business
    ? businessMinutesBetween(new Date(t.sla_paused_at), now, await loadCalendar(t.company_id, tx))
    : Math.max(0, Math.round((now.getTime() - new Date(t.sla_paused_at).getTime()) / 60_000));
  const shift = async (due: Date | null) => (due ? dueFrom(t.company_id, new Date(due), paused, sla.business) : null);
  await tx.query(
    `UPDATE tickets SET
       first_response_due_at = $2, resolution_due_at = $3,
       sla_paused_at = NULL, sla_paused_minutes = sla_paused_minutes + $4
     WHERE id = $1`,
    [ticketId,
      t.first_responded_at ? t.first_response_due_at : await shift(t.first_response_due_at),
      t.resolved_at ? t.resolution_due_at : await shift(t.resolution_due_at),
      paused],
  );
}

/* ---------------------------------------------------------------- tickets */

type CreateInput = {
  subject: string;
  description: string;
  type?: TicketType;
  priority?: TicketPriority;
  queueId: string;
  categoryId?: string | null;
  /** Raising a ticket on someone's behalf; workers only. */
  requesterId?: string | null;
  clientOrgId?: string | null;
  formAnswers?: Record<string, unknown>;
};

export async function insertTicket(
  actor: Actor,
  fields: { subject: string; description: string; type: TicketType; priority: TicketPriority; queueId: string; categoryId: string | null; requesterId: string; clientOrgId: string | null; channel: 'workspace' | 'portal' | 'email'; formAnswers?: Record<string, unknown> },
): Promise<TicketRow> {
  const sla = await slaFor(actor.companyId, fields.priority);
  const createdAt = new Date();
  const firstDue = await dueFrom(actor.companyId, createdAt, sla.firstResponse, sla.business);
  const resolutionDue = await dueFrom(actor.companyId, createdAt, sla.resolution, sla.business);
  let answers: Record<string, unknown> | null = null;
  if (fields.categoryId) {
    const cat = await one<{ form_fields: unknown }>('SELECT form_fields FROM service_categories WHERE id = $1', [fields.categoryId]);
    const form = parseJson<FormField[]>(cat?.form_fields, []);
    if (form.length) answers = validateAnswers(form, fields.formAnswers);
  }
  const ticket = await transaction(async (tx) => {
    await tx.query('INSERT IGNORE INTO ticket_counters (company_id, next_number) VALUES ($1, 1)', [actor.companyId]);
    const counter = await tx.query<{ next_number: number }>('SELECT next_number FROM ticket_counters WHERE company_id = $1 FOR UPDATE', [actor.companyId]);
    const number = Number(counter.rows[0]!.next_number);
    await tx.query('UPDATE ticket_counters SET next_number = next_number + 1 WHERE company_id = $1', [actor.companyId]);
    const id = newId();
    await tx.query(
      `INSERT INTO tickets
         (id, company_id, number, subject, description, type, status, priority, channel,
          queue_id, category_id, requester_id, client_org_id,
          first_response_due_at, resolution_due_at, form_answers, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'new',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, actor.companyId, number, fields.subject.trim(), fields.description.trim(), fields.type, fields.priority, fields.channel,
        fields.queueId, fields.categoryId, fields.requesterId, fields.clientOrgId, firstDue, resolutionDue,
        answers ? JSON.stringify(answers) : null, createdAt],
    );
    const row = (await tx.query<TicketRow>('SELECT * FROM tickets WHERE id = $1', [id])).rows[0]!;
    await recordEvent(tx, row, actor.userId, 'created', null, fields.channel);
    await auditFromActor(actor, 'ticket.create', { resourceType: 'ticket', resourceId: id, metadata: { number, queueId: fields.queueId, priority: fields.priority, channel: fields.channel } }, tx);
    return row;
  });

  // Tell the queue. Outside the transaction: a failed notification must not undo a ticket.
  const members = await many<{ user_id: string }>('SELECT user_id FROM service_queue_members WHERE queue_id = $1', [ticket.queue_id]);
  for (const m of members) {
    // Not the person who raised it, nor the requester it was raised for: they know.
    if (m.user_id === actor.userId || m.user_id === ticket.requester_id) continue;
    await notifications.create({
      companyId: ticket.company_id, userId: m.user_id, type: 'ticket.created',
      title: `New ticket ${ticketRef(ticket.number)}: ${ticket.subject}`.slice(0, 300),
      body: `Priority ${ticket.priority}`, link: `/service/tickets/${ticket.id}`,
      resourceType: 'ticket', resourceId: ticket.id, dedupeKey: `ticket-created:${ticket.id}:${m.user_id}`,
    });
  }
  await indexTicket(ticket);
  await broadcastChange(ticket);
  return ticket;
}

export async function createTicket(actor: Actor, input: CreateInput) {
  if (actor.accessLevel === 'guest') throw forbidden('Clients raise tickets from the portal');
  await authorize({ actor, capability: 'ticket.create', resourceless: true });
  const queue = await one<{ id: string; audience: string; is_active: number }>(
    'SELECT id, audience, is_active FROM service_queues WHERE id = $1 AND company_id = $2',
    [input.queueId, actor.companyId],
  );
  if (!queue || !queue.is_active) throw unprocessable('Choose an active queue', [{ field: 'queueId', message: 'Queue not available' }]);

  const isWorker = hasCapability(actor, 'ticket.work') || (await memberQueueIds(actor)).includes(queue.id);
  if (queue.audience === 'client' && !isWorker) {
    throw unprocessable('That queue takes client requests', [{ field: 'queueId', message: 'Choose an internal queue' }]);
  }
  if ((input.requesterId && input.requesterId !== actor.userId) || input.clientOrgId) {
    if (!isWorker) throw forbidden('Only people working this queue can raise tickets for someone else');
  }
  if (input.categoryId) {
    const cat = await one('SELECT 1 FROM service_categories WHERE id = $1 AND queue_id = $2 AND is_active = 1', [input.categoryId, queue.id]);
    if (!cat) throw unprocessable('That category does not belong to this queue', [{ field: 'categoryId', message: 'Choose a category in this queue' }]);
  }
  let requesterId = actor.userId;
  let clientOrgId: string | null = input.clientOrgId ?? null;
  if (input.requesterId && input.requesterId !== actor.userId) {
    const requester = await one<{ access_level: string }>('SELECT access_level FROM users WHERE id = $1 AND company_id = $2 AND status = \'active\'', [input.requesterId, actor.companyId]);
    if (!requester) throw unprocessable('Requester not found', [{ field: 'requesterId', message: 'Choose an active person' }]);
    requesterId = input.requesterId;
    if (requester.access_level === 'guest') {
      const membership = await one<{ organization_id: string }>('SELECT organization_id FROM external_memberships WHERE user_id = $1 AND company_id = $2 LIMIT 1', [requesterId, actor.companyId]);
      clientOrgId = membership?.organization_id ?? clientOrgId;
    }
  }
  if (clientOrgId && !(await one('SELECT 1 FROM external_organizations WHERE id = $1 AND company_id = $2', [clientOrgId, actor.companyId]))) {
    throw unprocessable('Client not found', [{ field: 'clientOrgId', message: 'Choose a client' }]);
  }
  const ticket = await insertTicket(actor, {
    subject: input.subject, description: input.description, type: input.type ?? 'request', priority: input.priority ?? 'normal',
    queueId: queue.id, categoryId: input.categoryId ?? null, requesterId, clientOrgId, channel: 'workspace', formAnswers: input.formAnswers,
  });
  return getTicket(actor, ticket.id);
}

/** A client raising a ticket from the portal, always against their own organisation. */
export async function createPortalTicket(actor: Actor, input: { subject: string; description: string; priority?: TicketPriority; queueId?: string | null }) {
  await authorize({ actor, capability: 'portal.read', resourceless: true });
  const orgId = await guestOrganisationId(actor);
  if (!orgId) throw forbidden('Your access to this workspace has ended');
  const queue = await one<{ id: string }>(
    `SELECT id FROM service_queues
      WHERE company_id = $1 AND audience = 'client' AND is_active = 1 ${input.queueId ? 'AND id = $2' : ''}
      ORDER BY name LIMIT 1`,
    input.queueId ? [actor.companyId, input.queueId] : [actor.companyId],
  );
  if (!queue) throw unprocessable('Support requests are not open yet. Please contact your account manager.');
  // Clients choose between normal and high; urgent is decided by the people working it.
  const priority: TicketPriority = input.priority === 'high' ? 'high' : input.priority === 'low' ? 'low' : 'normal';
  const ticket = await insertTicket(actor, {
    subject: input.subject, description: input.description, type: 'request', priority,
    queueId: queue.id, categoryId: null, requesterId: actor.userId, clientOrgId: orgId, channel: 'portal',
  });
  return getTicket(actor, ticket.id);
}

export type ListFilter = {
  view?: 'all' | 'mine' | 'assigned' | 'unassigned' | 'breached' | 'requested';
  queueId?: string;
  status?: TicketStatus | 'active';
  priority?: TicketPriority;
  clientOrgId?: string;
  requesterId?: string;
  q?: string;
  limit: number;
  cursor?: string;
};

export async function listTickets(actor: Actor, filter: ListFilter) {
  const where: string[] = ['t.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  const p = (value: unknown) => { params.push(value); return `$${params.length}`; };

  if (actor.accessLevel === 'guest') {
    await authorize({ actor, capability: 'portal.read', resourceless: true });
    const org = await guestOrganisationId(actor);
    where.push(org ? `(t.requester_id = ${p(actor.userId)} OR t.client_org_id = ${p(org)})` : `t.requester_id = ${p(actor.userId)}`);
  } else {
    await authorize({ actor, capability: 'ticket.create', resourceless: true });
    const all = hasCapability(actor, 'ticket.read') || hasCapability(actor, 'ticket.work');
    if (!all) {
      const queues = await memberQueueIds(actor);
      where.push(queues.length > 0
        ? `(t.requester_id = ${p(actor.userId)} OR t.queue_id IN (${queues.map((q) => p(q)).join(',')}))`
        : `t.requester_id = ${p(actor.userId)}`);
    }
  }

  switch (filter.view) {
    case 'mine': case 'assigned': where.push(`t.assignee_id = ${p(actor.userId)}`); break;
    case 'unassigned': where.push('t.assignee_id IS NULL'); break;
    case 'requested': where.push(`t.requester_id = ${p(actor.userId)}`); break;
    case 'breached': where.push("(t.response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL) AND t.status NOT IN ('resolved','closed')"); break;
    default: break;
  }
  if (filter.status === 'active') where.push("t.status NOT IN ('resolved','closed')");
  else if (filter.status) where.push(`t.status = ${p(filter.status)}`);
  if (filter.queueId) where.push(`t.queue_id = ${p(filter.queueId)}`);
  if (filter.priority) where.push(`t.priority = ${p(filter.priority)}`);
  if (filter.clientOrgId && actor.accessLevel !== 'guest') where.push(`t.client_org_id = ${p(filter.clientOrgId)}`);
  if (filter.requesterId && actor.accessLevel !== 'guest') where.push(`t.requester_id = ${p(filter.requesterId)}`);
  if (filter.q?.trim()) {
    const term = filter.q.trim();
    const asNumber = /^(sd-)?\d+$/i.test(term) ? Number(term.replace(/^sd-/i, '')) : null;
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(asNumber !== null ? `(t.number = ${p(asNumber)} OR t.subject LIKE ${p(like)})` : `t.subject LIKE ${p(like)}`);
  }
  const cursor = decodeCursor(filter.cursor);
  if (cursor) where.push(`(t.created_at, t.id) < (${p(cursor.at)}, ${p(cursor.id)})`);

  const rows = await many<TicketRow & {
    queue_name: string; requester_name: string; assignee_name: string | null; client_name: string | null; category_name: string | null;
  }>(
    `SELECT t.*, q.name AS queue_name, ru.display_name AS requester_name, au.display_name AS assignee_name,
            o.name AS client_name, c.name AS category_name
       FROM tickets t
       JOIN service_queues q ON q.id = t.queue_id
       JOIN users ru ON ru.id = t.requester_id
       LEFT JOIN users au ON au.id = t.assignee_id
       LEFT JOIN external_organizations o ON o.id = t.client_org_id
       LEFT JOIN service_categories c ON c.id = t.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ${p(filter.limit + 1)}`,
    params,
  );
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  const guest = actor.accessLevel === 'guest';
  return {
    items: page.map((t) => ({
      ...summary(t),
      queueName: guest ? null : t.queue_name,
      requesterName: t.requester_name,
      assigneeName: t.assignee_name,
      clientName: t.client_name,
      categoryName: t.category_name,
    })),
    nextCursor: hasMore ? encodeCursor({ at: page[page.length - 1]!.created_at, id: page[page.length - 1]!.id }) : null,
  };
}

function slaState(t: TicketRow) {
  const now = Date.now();
  const done = t.status === 'resolved' || t.status === 'closed';
  const state = (due: Date | null, met: Date | null, breached: Date | null) => {
    if (!due) return 'none';
    if (met) return met.getTime() <= due.getTime() ? 'met' : 'missed';
    if (breached) return 'breached';
    // A paused target is not late: its due time moves out when the pause ends.
    if (t.sla_paused_at && !done) return 'paused';
    if (due.getTime() < now) return 'breached';
    if (done) return 'met';
    return due.getTime() - now < 60 * 60 * 1000 ? 'at_risk' : 'on_track';
  };
  return {
    pausedSince: t.sla_paused_at,
    firstResponseDueAt: t.first_response_due_at,
    resolutionDueAt: t.resolution_due_at,
    firstResponse: state(t.first_response_due_at, t.first_responded_at, t.response_breached_at),
    resolution: state(t.resolution_due_at, t.resolved_at, t.resolution_breached_at),
  };
}

function summary(t: TicketRow) {
  return {
    id: t.id,
    number: t.number,
    ref: ticketRef(t.number),
    subject: t.subject,
    type: t.type,
    status: t.status,
    priority: t.priority,
    channel: t.channel,
    queueId: t.queue_id,
    categoryId: t.category_id,
    requesterId: t.requester_id,
    clientOrgId: t.client_org_id,
    assigneeId: t.assignee_id,
    taskId: t.task_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    resolvedAt: t.resolved_at,
    sla: slaState(t),
    version: t.version,
  };
}

export async function getTicket(actor: Actor, id: string) {
  const { ticket, access: acc } = await loadTicket(actor, id);
  const names = await one<{ queue_name: string; requester_name: string; requester_email: string; assignee_name: string | null; client_name: string | null; category_name: string | null; task_title: string | null; task_ref: string | null }>(
    `SELECT q.name AS queue_name, ru.display_name AS requester_name, ru.email AS requester_email,
            au.display_name AS assignee_name, o.name AS client_name, c.name AS category_name,
            tk.title AS task_title, CONCAT(p.key, '-', tk.number) AS task_ref
       FROM tickets t
       JOIN service_queues q ON q.id = t.queue_id
       JOIN users ru ON ru.id = t.requester_id
       LEFT JOIN users au ON au.id = t.assignee_id
       LEFT JOIN external_organizations o ON o.id = t.client_org_id
       LEFT JOIN service_categories c ON c.id = t.category_id
       LEFT JOIN tasks tk ON tk.id = t.task_id
       LEFT JOIN projects p ON p.id = tk.project_id
      WHERE t.id = $1`,
    [ticket.id],
  );
  const comments = await many<{ id: string; author_id: string; author_name: string; author_is_guest: number; visibility: string; body: string; created_at: Date }>(
    `SELECT c.id, c.author_id, u.display_name AS author_name, u.access_level = 'guest' AS author_is_guest,
            c.visibility, c.body, c.created_at
       FROM ticket_comments c JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = $1 ${acc.seesInternal ? '' : "AND c.visibility = 'public'"}
      ORDER BY c.created_at, c.id`,
    [ticket.id],
  );
  const attachments = await many<{ file_id: string; name: string; size_bytes: number; mime_type: string; visibility: string; added_at: Date; added_by_name: string }>(
    `SELECT a.file_id, f.name, f.size_bytes, f.mime_type, a.visibility, a.added_at, u.display_name AS added_by_name
       FROM ticket_attachments a JOIN files f ON f.id = a.file_id JOIN users u ON u.id = a.added_by
      WHERE a.ticket_id = $1 AND f.state = 'active' ${acc.seesInternal ? '' : "AND a.visibility = 'public'"}
      ORDER BY a.added_at`,
    [ticket.id],
  );
  // The requester side sees the milestones; internal reassignment is not their business.
  // Reassignment and moves store ids; the timeline reads better with the names.
  const events = await many<{ id: number; kind: string; from_value: string | null; to_value: string | null; created_at: Date; actor_name: string | null }>(
    `SELECT e.id, e.kind, e.from_value, e.created_at, u.display_name AS actor_name,
            CASE e.kind
              WHEN 'assignee' THEN (SELECT display_name FROM users WHERE id = e.to_value AND company_id = e.company_id)
              WHEN 'queue'    THEN (SELECT name FROM service_queues WHERE id = e.to_value AND company_id = e.company_id)
              WHEN 'category' THEN (SELECT name FROM service_categories WHERE id = e.to_value AND company_id = e.company_id)
              WHEN 'client'   THEN (SELECT name FROM external_organizations WHERE id = e.to_value AND company_id = e.company_id)
              WHEN 'task'     THEN (SELECT title FROM tasks WHERE id = e.to_value AND company_id = e.company_id)
              ELSE e.to_value
            END AS to_value
       FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.ticket_id = $1 ${acc.seesInternal ? '' : "AND e.kind IN ('created','status')"}
      ORDER BY e.id`,
    [ticket.id],
  );
  const { articlesForTicket } = await import('./knowledge.js');
  const articles = await articlesForTicket(actor, ticket.id);
  const category = ticket.category_id
    ? await one<{ form_fields: unknown }>('SELECT form_fields FROM service_categories WHERE id = $1', [ticket.category_id])
    : null;
  const formFields = parseJson<FormField[]>(category?.form_fields, []);
  const answers = parseJson<Record<string, unknown>>(ticket.form_answers, {});
  const problem = !guestView(actor) ? await one<{ id: string; number: number; subject: string; status: string }>(
    `SELECT p.id, p.number, p.subject, p.status FROM ticket_problem_links l JOIN tickets p ON p.id = l.problem_id
      WHERE l.incident_id = $1`, [ticket.id]) : null;
  const incidents = !guestView(actor) && ticket.type === 'problem' ? await many<{ id: string; number: number; subject: string; status: string }>(
    `SELECT i.id, i.number, i.subject, i.status FROM ticket_problem_links l JOIN tickets i ON i.id = l.incident_id
      WHERE l.problem_id = $1 ORDER BY i.created_at`, [ticket.id]) : [];
  const assets = !guestView(actor) ? await many<{ id: string; asset_tag: string; name: string; status: string; warranty_until: string | null }>(
    `SELECT a.id, a.asset_tag, a.name, a.status, DATE_FORMAT(a.warranty_until, '%Y-%m-%d') AS warranty_until
       FROM ticket_assets ta JOIN assets a ON a.id = ta.asset_id WHERE ta.ticket_id = $1 ORDER BY ta.linked_at`, [ticket.id]) : [];
  const changes = !guestView(actor) ? await many<{ id: string; number: number; title: string; status: string }>(
    `SELECT c.id, c.number, c.title, c.status FROM change_ticket_links l JOIN change_requests c ON c.id = l.change_id
      WHERE l.ticket_id = $1 ORDER BY l.linked_at`, [ticket.id]) : [];
  const feedback = await one<{ rating: number; comment: string | null; created_at: Date }>(
    'SELECT rating, comment, created_at FROM ticket_feedback WHERE ticket_id = $1', [ticket.id],
  );
  const guest = actor.accessLevel === 'guest';
  return {
    ...summary(ticket),
    description: ticket.description,
    firstRespondedAt: ticket.first_responded_at,
    closedAt: ticket.closed_at,
    queueName: guest ? null : names?.queue_name ?? null,
    categoryName: names?.category_name ?? null,
    requesterName: names?.requester_name ?? null,
    requesterEmail: guest ? null : names?.requester_email ?? null,
    assigneeName: names?.assignee_name ?? null,
    clientName: names?.client_name ?? null,
    task: ticket.task_id && !guest ? { id: ticket.task_id, title: names?.task_title ?? null, ref: names?.task_ref ?? null } : null,
    comments: comments.map((c) => ({
      id: c.id, authorId: c.author_id, authorName: c.author_name, fromRequesterSide: c.author_id === ticket.requester_id || Boolean(c.author_is_guest),
      visibility: c.visibility, body: c.body, createdAt: c.created_at,
    })),
    attachments: attachments.map((a) => ({ fileId: a.file_id, name: a.name, sizeBytes: Number(a.size_bytes), mimeType: a.mime_type, visibility: a.visibility, addedAt: a.added_at, addedByName: a.added_by_name })),
    events: events.map((e) => ({ id: Number(e.id), kind: e.kind, from: e.from_value, to: e.to_value, createdAt: e.created_at, actorName: e.actor_name })),
    feedback: feedback ? { rating: Number(feedback.rating), comment: feedback.comment, createdAt: feedback.created_at } : null,
    form: formFields.filter((f) => answers[f.key] !== undefined).map((f) => ({ key: f.key, label: f.label, type: f.type, value: answers[f.key] })),
    articles,
    rootCause: acc.seesInternal ? ticket.root_cause : null,
    workaround: ticket.type === 'problem' || acc.seesInternal ? ticket.workaround : null,
    problem: problem ? { id: problem.id, ref: ticketRef(problem.number), subject: problem.subject, status: problem.status } : null,
    incidents: incidents.map((i) => ({ id: i.id, ref: ticketRef(i.number), subject: i.subject, status: i.status })),
    assets: assets.map((a) => ({ id: a.id, tag: a.asset_tag, name: a.name, status: a.status, warrantyUntil: a.warranty_until })),
    changes: changes.map((c) => ({ id: c.id, ref: `CHG-${c.number}`, title: c.title, status: c.status })),
    permissions: {
      canWork: acc.canWork,
      seesInternal: acc.seesInternal,
      canReply: acc.canWork || acc.isRequesterSide,
      canRate: acc.isRequesterSide && !feedback && (ticket.status === 'resolved' || ticket.status === 'closed'),
      canClose: (acc.canWork || acc.isRequesterSide) && ticket.status !== 'closed',
      canReopen: (acc.canWork || acc.isRequesterSide) && (ticket.status === 'resolved' || ticket.status === 'closed'),
    },
  };
}

export type UpdateInput = {
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  queueId?: string;
  categoryId?: string | null;
  assigneeId?: string | null;
  clientOrgId?: string | null;
  subject?: string;
};

export async function updateTicket(actor: Actor, id: string, input: UpdateInput, expectedVersion?: number) {
  const { ticket, access: acc } = await loadTicket(actor, id);
  const workerFields: (keyof UpdateInput)[] = ['priority', 'type', 'queueId', 'categoryId', 'assigneeId', 'clientOrgId', 'subject'];
  const touchesWorkerFields = workerFields.some((f) => input[f] !== undefined);
  if (!acc.canWork) {
    // The requester side may only close their ticket or reopen it.
    if (touchesWorkerFields || !input.status || !acc.isRequesterSide) throw forbidden('Only people working this queue can change that');
    const allowed = input.status === 'closed' || (input.status === 'open' && (ticket.status === 'resolved' || ticket.status === 'closed'));
    if (!allowed) throw forbidden('You can close this ticket or reopen it');
  }
  if (expectedVersion !== undefined && expectedVersion !== ticket.version) throw preconditionFailed('This ticket changed since you opened it. Reload to see the latest.');

  const queueId = input.queueId ?? ticket.queue_id;
  if (input.queueId && input.queueId !== ticket.queue_id) {
    const q = await one<{ is_active: number }>('SELECT is_active FROM service_queues WHERE id = $1 AND company_id = $2', [input.queueId, actor.companyId]);
    if (!q || !q.is_active) throw unprocessable('Choose an active queue', [{ field: 'queueId', message: 'Queue not available' }]);
  }
  if (input.categoryId) {
    const cat = await one('SELECT 1 FROM service_categories WHERE id = $1 AND queue_id = $2', [input.categoryId, queueId]);
    if (!cat) throw unprocessable('That category does not belong to this queue', [{ field: 'categoryId', message: 'Choose a category in this queue' }]);
  }
  // Moving queues drops a category and an assignee that belonged to the old one.
  let assigneeId = input.assigneeId !== undefined ? input.assigneeId : ticket.assignee_id;
  let categoryId = input.categoryId !== undefined ? input.categoryId : ticket.category_id;
  if (queueId !== ticket.queue_id) {
    if (input.categoryId === undefined) categoryId = null;
    if (input.assigneeId === undefined && assigneeId) {
      try { await assertAssignable(actor.companyId, queueId, assigneeId); } catch { assigneeId = null; }
    }
  }
  if (input.assigneeId) await assertAssignable(actor.companyId, queueId, input.assigneeId);
  if (input.clientOrgId && !(await one('SELECT 1 FROM external_organizations WHERE id = $1 AND company_id = $2', [input.clientOrgId, actor.companyId]))) {
    throw unprocessable('Client not found', [{ field: 'clientOrgId', message: 'Choose a client' }]);
  }

  const status = input.status ?? ticket.status;
  const priority = input.priority ?? ticket.priority;
  const sla = priority !== ticket.priority ? await slaFor(actor.companyId, priority) : null;
  // Recalculated from creation, then moved out by any time already spent paused.
  const recalc = async (minutes: number) => {
    const base = await dueFrom(actor.companyId, new Date(ticket.created_at), minutes, sla!.business);
    return dueFrom(actor.companyId, base, Number(ticket.sla_paused_minutes ?? 0), sla!.business);
  };
  const newFirstDue = sla ? await recalc(sla.firstResponse) : null;
  const newResolutionDue = sla ? await recalc(sla.resolution) : null;

  const updated = await transaction(async (tx) => {
    const res = await tx.query(
      // MySQL applies SET assignments left to right, so the timestamps that compare
      // against the old status must come before status itself is overwritten.
      `UPDATE tickets SET
         resolved_at = CASE WHEN $4 = 'resolved' AND status <> 'resolved' THEN NOW(3)
                            WHEN $4 IN ('new','open','pending') THEN NULL ELSE resolved_at END,
         closed_at = CASE WHEN $4 = 'closed' AND status <> 'closed' THEN NOW(3)
                          WHEN $4 <> 'closed' THEN NULL ELSE closed_at END,
         subject = $3, status = $4, priority = $5, type = $6, queue_id = $7, category_id = $8,
         assignee_id = $9, client_org_id = $10,
         first_response_due_at = COALESCE($11, first_response_due_at),
         resolution_due_at = COALESCE($12, resolution_due_at),
         -- A new target is judged afresh; the breach job will re-flag it if still late.
         response_breached_at = CASE WHEN $11 IS NULL THEN response_breached_at ELSE NULL END,
         resolution_breached_at = CASE WHEN $12 IS NULL THEN resolution_breached_at ELSE NULL END,
         version = version + 1
       WHERE id = $1 AND company_id = $2 AND version = $13`,
      [ticket.id, actor.companyId, input.subject?.trim() ?? ticket.subject, status, priority, input.type ?? ticket.type,
        queueId, categoryId, assigneeId, input.clientOrgId !== undefined ? input.clientOrgId : ticket.client_org_id,
        newFirstDue, newResolutionDue, ticket.version],
    );
    if (res.rowCount === 0) throw preconditionFailed('This ticket changed since you opened it. Reload to see the latest.');
    await applyPause(tx, ticket.id, ticket.status, status);
    const changes: [string, string | null, string | null][] = [];
    if (status !== ticket.status) changes.push(['status', ticket.status, status]);
    if (priority !== ticket.priority) changes.push(['priority', ticket.priority, priority]);
    if ((input.type ?? ticket.type) !== ticket.type) changes.push(['type', ticket.type, input.type!]);
    if (queueId !== ticket.queue_id) changes.push(['queue', ticket.queue_id, queueId]);
    if (assigneeId !== ticket.assignee_id) changes.push(['assignee', ticket.assignee_id, assigneeId]);
    if (categoryId !== ticket.category_id) changes.push(['category', ticket.category_id, categoryId]);
    if (input.clientOrgId !== undefined && input.clientOrgId !== ticket.client_org_id) changes.push(['client', ticket.client_org_id, input.clientOrgId]);
    if (input.subject !== undefined && input.subject.trim() !== ticket.subject) changes.push(['subject', ticket.subject, input.subject.trim()]);
    for (const [kind, from, to] of changes) await recordEvent(tx, ticket, actor.userId, kind, from, to);
    await auditFromActor(actor, 'ticket.update', { resourceType: 'ticket', resourceId: ticket.id, metadata: { changes: changes.map((c) => c[0]) } }, tx);
    return (await tx.query<TicketRow>('SELECT * FROM tickets WHERE id = $1', [ticket.id])).rows[0]!;
  });

  if (updated.assignee_id && updated.assignee_id !== ticket.assignee_id && updated.assignee_id !== actor.userId) {
    await notifications.create({
      companyId: updated.company_id, userId: updated.assignee_id, type: 'ticket.assigned',
      title: `${ticketRef(updated.number)} assigned to you`, body: updated.subject,
      link: `/service/tickets/${updated.id}`, resourceType: 'ticket', resourceId: updated.id,
      dedupeKey: `ticket-assigned:${updated.id}:${updated.assignee_id}:${updated.version}`,
    });
  }
  if (updated.status !== ticket.status && updated.requester_id !== actor.userId && (updated.status === 'resolved' || updated.status === 'closed')) {
    await notifications.create({
      companyId: updated.company_id, userId: updated.requester_id, type: 'ticket.resolved',
      title: `${ticketRef(updated.number)} was ${updated.status}`, body: updated.subject,
      link: `/service/tickets/${updated.id}`, resourceType: 'ticket', resourceId: updated.id,
      dedupeKey: `ticket-status:${updated.id}:${updated.status}:${updated.version}`,
    });
  }
  await indexTicket(updated);
  await broadcastChange(updated);
  if (ticket.assignee_id && ticket.assignee_id !== updated.assignee_id) publishToUser(ticket.assignee_id, 'ticket.updated', { id: updated.id });
  return getTicket(actor, id);
}

export async function addComment(actor: Actor, id: string, input: { body: string; visibility?: 'public' | 'internal' }) {
  const { ticket, access: acc } = await loadTicket(actor, id);
  const visibility = input.visibility ?? 'public';
  if (!acc.canWork && !acc.isRequesterSide) throw forbidden('You can read this ticket but not reply to it');
  if (visibility === 'internal' && !acc.canWork) throw forbidden('Only people working this queue can add internal notes');
  if (ticket.status === 'closed' && !acc.canWork) throw conflict('This ticket is closed. Reopen it to reply.');
  const body = input.body.trim();
  if (!body) throw badRequest('Write something first');

  const fromRequesterSide = !acc.canWork;
  const commentId = newId();
  await transaction(async (tx) => {
    await tx.query('INSERT INTO ticket_comments (id, ticket_id, company_id, author_id, visibility, body) VALUES ($1,$2,$3,$4,$5,$6)',
      [commentId, ticket.id, ticket.company_id, actor.userId, visibility, body]);
    let nextStatus: TicketStatus = ticket.status;
    if (visibility === 'public') {
      if (!fromRequesterSide) {
        await tx.query('UPDATE tickets SET first_responded_at = COALESCE(first_responded_at, NOW(3)) WHERE id = $1', [ticket.id]);
        if (ticket.status === 'new') nextStatus = 'open';
      } else if (ticket.status === 'pending' || ticket.status === 'resolved') {
        // The requester answered or disagreed: it needs attention again.
        nextStatus = 'open';
      }
    }
    if (nextStatus !== ticket.status) {
      await tx.query(
        `UPDATE tickets SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN resolved_at ELSE NULL END, version = version + 1 WHERE id = $1`,
        [ticket.id, nextStatus],
      );
      await applyPause(tx, ticket.id, ticket.status, nextStatus);
      await recordEvent(tx, ticket, actor.userId, 'status', ticket.status, nextStatus);
    } else {
      await tx.query('UPDATE tickets SET version = version + 1 WHERE id = $1', [ticket.id]);
    }
    await recordEvent(tx, ticket, actor.userId, visibility === 'internal' ? 'note' : 'reply');
    await auditFromActor(actor, 'ticket.comment', { resourceType: 'ticket', resourceId: ticket.id, metadata: { visibility } }, tx);
    if (visibility === 'public' && !fromRequesterSide) {
      await emit({ companyId: ticket.company_id, type: 'ticket.replied', actorId: actor.userId, payload: { ticketId: ticket.id, commentId } }, tx);
    }
  });

  // Tell the other side.
  const ref = ticketRef(ticket.number);
  if (visibility === 'public' && !fromRequesterSide && ticket.requester_id !== actor.userId) {
    await notifications.create({
      companyId: ticket.company_id, userId: ticket.requester_id, type: 'ticket.replied',
      title: `Reply on ${ref}: ${ticket.subject}`.slice(0, 300), body: body.slice(0, 200),
      link: `/service/tickets/${ticket.id}`, resourceType: 'ticket', resourceId: ticket.id, dedupeKey: `ticket-reply:${commentId}`,
    });
  }
  if (fromRequesterSide) {
    const targets = ticket.assignee_id
      ? [ticket.assignee_id]
      : (await many<{ user_id: string }>('SELECT user_id FROM service_queue_members WHERE queue_id = $1', [ticket.queue_id])).map((m) => m.user_id);
    for (const userId of targets) {
      if (userId === actor.userId) continue;
      await notifications.create({
        companyId: ticket.company_id, userId, type: 'ticket.replied',
        title: `${actor.displayName} replied on ${ref}`.slice(0, 300), body: body.slice(0, 200),
        link: `/service/tickets/${ticket.id}`, resourceType: 'ticket', resourceId: ticket.id, dedupeKey: `ticket-reply:${commentId}:${userId}`,
      });
    }
  }
  const fresh = await one<TicketRow>('SELECT * FROM tickets WHERE id = $1', [ticket.id]);
  if (fresh) await broadcastChange(fresh);
  return getTicket(actor, id);
}

export async function attachFile(actor: Actor, id: string, input: { fileId: string; visibility?: 'public' | 'internal' }) {
  const { ticket, access: acc } = await loadTicket(actor, id);
  const visibility = input.visibility ?? 'public';
  if (!acc.canWork && !acc.isRequesterSide) throw forbidden('You can read this ticket but not add files to it');
  if (visibility === 'internal' && !acc.canWork) throw forbidden('Only people working this queue can attach internal files');
  // Only a file this person uploaded themselves, so a ticket cannot be used to lift
  // someone else's file out of a folder they cannot open.
  const file = await one<{ id: string; name: string }>(
    "SELECT id, name FROM files WHERE id = $1 AND company_id = $2 AND owner_id = $3 AND state = 'active'",
    [input.fileId, actor.companyId, actor.userId],
  );
  if (!file) throw unprocessable('Upload the file first', [{ field: 'fileId', message: 'File not found' }]);
  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO ticket_attachments (ticket_id, file_id, company_id, visibility, added_by) VALUES ($1,$2,$3,$4,$5)
       ON DUPLICATE KEY UPDATE visibility = VALUES(visibility)`,
      [ticket.id, file.id, ticket.company_id, visibility, actor.userId],
    );
    await recordEvent(tx, ticket, actor.userId, 'attachment', null, file.name);
    await auditFromActor(actor, 'ticket.attach', { resourceType: 'ticket', resourceId: ticket.id, metadata: { fileId: file.id, visibility } }, tx);
  });
  return getTicket(actor, id);
}

/** Download authorised by the ticket rather than by folder grants. */
export async function attachmentDownload(actor: Actor, id: string, fileId: string) {
  const { ticket, access: acc } = await loadTicket(actor, id);
  const row = await one<{ visibility: string }>('SELECT visibility FROM ticket_attachments WHERE ticket_id = $1 AND file_id = $2', [ticket.id, fileId]);
  if (!row || (row.visibility === 'internal' && !acc.seesInternal)) throw notFound('Attachment not found');
  const { signedDownloadForShare } = await import('./files.js');
  const download = await signedDownloadForShare(fileId);
  await auditFromActor(actor, 'ticket.attachment.download', { resourceType: 'ticket', resourceId: ticket.id, metadata: { fileId } });
  return download;
}

export async function linkTask(actor: Actor, id: string, input: { projectId: string }, correlationId: string) {
  const { ticket } = await requireWorker(actor, id);
  if (ticket.task_id) throw conflict('This ticket already has a task');
  const { createTask } = await import('./tasks.js');
  const task = await createTask(actor, input.projectId, {
    title: `${ticketRef(ticket.number)}: ${ticket.subject}`.slice(0, 300),
    description: `Created from service ticket ${ticketRef(ticket.number)}.\n\n${ticket.description}`.slice(0, 20000),
    assigneeId: ticket.assignee_id,
    priority: ticket.priority === 'normal' ? 'medium' : ticket.priority,
  }, correlationId);
  await transaction(async (tx) => {
    const res = await tx.query('UPDATE tickets SET task_id = $2, version = version + 1 WHERE id = $1 AND task_id IS NULL', [ticket.id, task.id]);
    if (res.rowCount === 0) throw conflict('This ticket already has a task');
    await recordEvent(tx, ticket, actor.userId, 'task', null, task.id);
    await auditFromActor(actor, 'ticket.task.link', { resourceType: 'ticket', resourceId: ticket.id, metadata: { taskId: task.id } }, tx);
  });
  return getTicket(actor, id);
}

export async function submitFeedback(actor: Actor, id: string, input: { rating: number; comment?: string | null }) {
  const { ticket, access: acc } = await loadTicket(actor, id);
  if (!acc.isRequesterSide) throw forbidden('Only the requester can rate this ticket');
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') throw conflict('You can rate a ticket once it is resolved');
  try {
    await pool.query('INSERT INTO ticket_feedback (ticket_id, company_id, rating, comment) VALUES ($1,$2,$3,$4)',
      [ticket.id, ticket.company_id, input.rating, input.comment?.trim() || null]);
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw conflict('This ticket has already been rated');
    throw err;
  }
  await recordEvent(pool, ticket, actor.userId, 'feedback', null, String(input.rating));
  await auditFromActor(actor, 'ticket.feedback', { resourceType: 'ticket', resourceId: ticket.id, metadata: { rating: input.rating } });
  return getTicket(actor, id);
}

/* ------------------------------------------------------------ bulk actions */

/**
 * The same change applied to several tickets, each through the normal update path, so
 * every rule, audit entry and notification is exactly what a single edit would produce.
 * One ticket failing does not stop the rest; the result says which failed and why.
 */
export async function bulkUpdate(actor: Actor, ids: string[], input: Pick<UpdateInput, 'status' | 'priority' | 'assigneeId' | 'queueId'>) {
  if (actor.accessLevel === 'guest') throw forbidden();
  const unique = [...new Set(ids)].slice(0, 100);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of unique) {
    try {
      const { access: acc } = await loadTicket(actor, id);
      if (!acc.canWork) throw forbidden('You do not work this ticket\'s queue');
      await updateTicket(actor, id, input);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: (err as Error).message });
    }
  }
  await auditFromActor(actor, 'ticket.bulk_update', { resourceType: 'ticket', metadata: { count: unique.length, failed: results.filter((r) => !r.ok).length, changes: Object.keys(input) } });
  return { updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results };
}

/* ------------------------------------------------------- related records */

/** For other domains that act on a ticket only when the caller works it. */
export async function assertWorker(actor: Actor, ticketId: string): Promise<void> {
  await requireWorker(actor, ticketId);
}

export async function linkArticle(actor: Actor, id: string, articleId: string) {
  const { linkToTicket } = await import('./knowledge.js');
  const article = await linkToTicket(actor, id, articleId, assertWorker);
  const { ticket } = await loadTicket(actor, id);
  await recordEvent(pool, ticket, actor.userId, 'article', null, article.title);
  return getTicket(actor, id);
}

/** Records the underlying fault and the known workaround on a problem ticket. */
export async function updateProblemRecord(actor: Actor, id: string, input: { rootCause?: string | null; workaround?: string | null }) {
  const { ticket } = await requireWorker(actor, id);
  if (ticket.type !== 'problem') throw unprocessable('Root cause and workaround are recorded on problem tickets');
  await pool.query(
    `UPDATE tickets SET root_cause = CASE WHEN $2 THEN $3 ELSE root_cause END,
                        workaround = CASE WHEN $4 THEN $5 ELSE workaround END, version = version + 1
      WHERE id = $1`,
    [id, input.rootCause !== undefined, input.rootCause?.trim() || null, input.workaround !== undefined, input.workaround?.trim() || null],
  );
  if (input.rootCause !== undefined) await recordEvent(pool, ticket, actor.userId, 'root_cause');
  if (input.workaround !== undefined) await recordEvent(pool, ticket, actor.userId, 'workaround');
  await auditFromActor(actor, 'ticket.problem.update', { resourceType: 'ticket', resourceId: id, metadata: { fields: Object.keys(input) } });
  return getTicket(actor, id);
}

/** Points an incident at the problem that explains it. One problem per incident. */
export async function linkProblem(actor: Actor, incidentId: string, problemId: string | null) {
  const { ticket: incident } = await requireWorker(actor, incidentId);
  if (problemId === null) {
    await pool.query('DELETE FROM ticket_problem_links WHERE incident_id = $1 AND company_id = $2', [incidentId, actor.companyId]);
    await recordEvent(pool, incident, actor.userId, 'problem', null, null);
    return getTicket(actor, incidentId);
  }
  if (problemId === incidentId) throw unprocessable('A ticket cannot be its own problem');
  const problem = await one<TicketRow>('SELECT * FROM tickets WHERE id = $1 AND company_id = $2', [problemId, actor.companyId]);
  if (!problem || problem.type !== 'problem') throw unprocessable('Choose a problem ticket', [{ field: 'problemId', message: 'That ticket is not a problem' }]);
  if (incident.type === 'problem') throw unprocessable('Link incidents to problems, not problems to each other');
  await pool.query(
    `INSERT INTO ticket_problem_links (incident_id, problem_id, company_id, linked_by) VALUES ($1,$2,$3,$4)
     ON DUPLICATE KEY UPDATE problem_id = VALUES(problem_id), linked_by = VALUES(linked_by)`,
    [incidentId, problemId, actor.companyId, actor.userId],
  );
  await recordEvent(pool, incident, actor.userId, 'problem', null, `${ticketRef(problem.number)} ${problem.subject}`);
  await recordEvent(pool, problem, actor.userId, 'incident', null, `${ticketRef(incident.number)} ${incident.subject}`);
  await auditFromActor(actor, 'ticket.problem.link', { resourceType: 'ticket', resourceId: incidentId, metadata: { problemId } });
  return getTicket(actor, incidentId);
}

export async function linkAsset(actor: Actor, id: string, assetId: string, remove = false) {
  const { ticket } = await requireWorker(actor, id);
  const asset = await one<{ asset_tag: string; name: string }>('SELECT asset_tag, name FROM assets WHERE id = $1 AND company_id = $2', [assetId, actor.companyId]);
  if (!asset) throw unprocessable('Asset not found', [{ field: 'assetId', message: 'Choose an asset' }]);
  if (remove) {
    await pool.query('DELETE FROM ticket_assets WHERE ticket_id = $1 AND asset_id = $2', [id, assetId]);
  } else {
    await pool.query('INSERT IGNORE INTO ticket_assets (ticket_id, asset_id, linked_by) VALUES ($1,$2,$3)', [id, assetId, actor.userId]);
  }
  await recordEvent(pool, ticket, actor.userId, remove ? 'asset_removed' : 'asset', null, `${asset.asset_tag} ${asset.name}`);
  await auditFromActor(actor, remove ? 'ticket.asset.unlink' : 'ticket.asset.link', { resourceType: 'ticket', resourceId: id, metadata: { assetId } });
  return getTicket(actor, id);
}

/** Tickets about one asset, for its history, filtered to the ones the caller could open. */
export async function ticketsForAsset(actor: Actor, assetId: string) {
  const rows = await many<TicketRow>(
    `SELECT t.* FROM ticket_assets ta JOIN tickets t ON t.id = ta.ticket_id
      WHERE ta.asset_id = $1 AND t.company_id = $2 ORDER BY t.created_at DESC LIMIT 200`,
    [assetId, actor.companyId],
  );
  const out = [];
  for (const t of rows) if ((await access(actor, t)).canView) out.push(summary(t));
  return out;
}

/* -------------------------------------------------------------- analytics */

export async function analytics(actor: Actor, days: number) {
  if (actor.accessLevel === 'guest') throw forbidden();
  const queues = await memberQueueIds(actor);
  const all = hasCapability(actor, 'ticket.read') || hasCapability(actor, 'ticket.work');
  if (!all && queues.length === 0) throw forbidden('Support analytics are for people who work a queue');
  const scope = all ? '' : `AND t.queue_id IN (${queues.map((_, i) => `$${i + 3}`).join(',')})`;
  const params = [actor.companyId, days, ...(all ? [] : queues)];

  const totals = await one<{ open: number; unassigned: number; breached: number; created: number; resolved: number; avg_first_response: number | null; avg_resolution: number | null; response_met: number; response_total: number }>(
    `SELECT
       SUM(t.status NOT IN ('resolved','closed')) AS open,
       SUM(t.status NOT IN ('resolved','closed') AND t.assignee_id IS NULL) AS unassigned,
       SUM(t.status NOT IN ('resolved','closed') AND (t.response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL)) AS breached,
       SUM(t.created_at >= DATE_SUB(NOW(3), INTERVAL $2 DAY)) AS created,
       SUM(t.resolved_at >= DATE_SUB(NOW(3), INTERVAL $2 DAY)) AS resolved,
       AVG(CASE WHEN t.first_responded_at IS NOT NULL AND t.created_at >= DATE_SUB(NOW(3), INTERVAL $2 DAY)
                THEN TIMESTAMPDIFF(MINUTE, t.created_at, t.first_responded_at) END) AS avg_first_response,
       AVG(CASE WHEN t.resolved_at >= DATE_SUB(NOW(3), INTERVAL $2 DAY)
                THEN TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at) END) AS avg_resolution,
       SUM(t.first_responded_at IS NOT NULL AND t.first_responded_at <= t.first_response_due_at AND t.created_at >= DATE_SUB(NOW(3), INTERVAL $2 DAY)) AS response_met,
       SUM(t.first_responded_at IS NOT NULL AND t.created_at >= DATE_SUB(NOW(3), INTERVAL $2 DAY)) AS response_total
     FROM tickets t WHERE t.company_id = $1 ${scope}`,
    params,
  );
  const byQueue = await many<{ queue_id: string; name: string; open: number; breached: number }>(
    `SELECT q.id AS queue_id, q.name,
            SUM(t.status NOT IN ('resolved','closed')) AS open,
            SUM(t.status NOT IN ('resolved','closed') AND (t.response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL)) AS breached
       FROM service_queues q LEFT JOIN tickets t ON t.queue_id = q.id
      WHERE q.company_id = $1 AND ($2 = $2) ${all ? '' : `AND q.id IN (${queues.map((_, i) => `$${i + 3}`).join(',')})`}
      GROUP BY q.id, q.name ORDER BY q.name`,
    params,
  );
  const byPriority = await many<{ priority: string; open: number }>(
    `SELECT t.priority, COUNT(*) AS open FROM tickets t
      WHERE t.company_id = $1 AND t.status NOT IN ('resolved','closed') AND ($2 = $2) ${scope}
      GROUP BY t.priority`,
    params,
  );
  const satisfaction = await one<{ average: number | null; responses: number }>(
    `SELECT AVG(f.rating) AS average, COUNT(*) AS responses FROM ticket_feedback f JOIN tickets t ON t.id = f.ticket_id
      WHERE f.company_id = $1 AND f.created_at >= DATE_SUB(NOW(3), INTERVAL $2 DAY) ${scope}`,
    params,
  );
  const n = (v: unknown) => Number(v ?? 0);
  return {
    days,
    open: n(totals?.open), unassigned: n(totals?.unassigned), breached: n(totals?.breached),
    created: n(totals?.created), resolved: n(totals?.resolved),
    averageFirstResponseMinutes: totals?.avg_first_response == null ? null : Math.round(Number(totals.avg_first_response)),
    averageResolutionMinutes: totals?.avg_resolution == null ? null : Math.round(Number(totals.avg_resolution)),
    firstResponseSlaRate: n(totals?.response_total) === 0 ? null : Math.round((n(totals?.response_met) / n(totals?.response_total)) * 100),
    byQueue: byQueue.map((q) => ({ queueId: q.queue_id, name: q.name, open: n(q.open), breached: n(q.breached) })),
    byPriority: PRIORITIES.map((priority) => ({ priority, open: n(byPriority.find((p) => p.priority === priority)?.open) })),
    satisfaction: { average: satisfaction?.average == null ? null : Math.round(Number(satisfaction.average) * 10) / 10, responses: n(satisfaction?.responses) },
  };
}

/* ------------------------------------------------------------ SLA monitor */

/**
 * Flags tickets that have passed a target, once each, and tells the people who can act.
 *
 * First response: the assignee, or the whole queue while nobody owns it. Resolution: the
 * assignee and the queue's escalation contact - that is the escalation rule. The breach
 * timestamp is the idempotency key, so a second instance or a retried tick does nothing.
 */
export async function checkSla(): Promise<{ response: number; resolution: number }> {
  const responses = await many<TicketRow>(
    `SELECT * FROM tickets
      WHERE status IN ('new','open') AND first_responded_at IS NULL
        AND response_breached_at IS NULL AND first_response_due_at < NOW(3)
      LIMIT 200`,
  );
  for (const t of responses) {
    const res = await pool.query('UPDATE tickets SET response_breached_at = NOW(3) WHERE id = $1 AND response_breached_at IS NULL', [t.id]);
    if (res.rowCount === 0) continue;
    await recordEvent(pool, t, null, 'sla_breach', null, 'first_response');
    const targets = t.assignee_id
      ? [t.assignee_id]
      : (await many<{ user_id: string }>('SELECT user_id FROM service_queue_members WHERE queue_id = $1', [t.queue_id])).map((m) => m.user_id);
    for (const userId of targets) {
      await notifications.create({
        companyId: t.company_id, userId, type: 'ticket.sla_breached',
        title: `${ticketRef(t.number)} missed its first-response target`, body: t.subject,
        link: `/service/tickets/${t.id}`, resourceType: 'ticket', resourceId: t.id, dedupeKey: `sla-response:${t.id}:${userId}`,
      });
    }
    await broadcastChange(t);
  }

  const resolutions = await many<TicketRow & { escalation_user_id: string | null }>(
    `SELECT t.*, q.escalation_user_id FROM tickets t JOIN service_queues q ON q.id = t.queue_id
      WHERE t.status IN ('new','open') AND t.resolution_breached_at IS NULL AND t.resolution_due_at < NOW(3)
      LIMIT 200`,
  );
  for (const t of resolutions) {
    const res = await pool.query('UPDATE tickets SET resolution_breached_at = NOW(3) WHERE id = $1 AND resolution_breached_at IS NULL', [t.id]);
    if (res.rowCount === 0) continue;
    await recordEvent(pool, t, null, 'sla_breach', null, 'resolution');
    const targets = new Set<string>();
    if (t.assignee_id) targets.add(t.assignee_id);
    if (t.escalation_user_id) targets.add(t.escalation_user_id);
    if (targets.size === 0) {
      for (const m of await many<{ user_id: string }>('SELECT user_id FROM service_queue_members WHERE queue_id = $1', [t.queue_id])) targets.add(m.user_id);
    }
    for (const userId of targets) {
      await notifications.create({
        companyId: t.company_id, userId, type: 'ticket.sla_breached',
        title: `${ticketRef(t.number)} missed its resolution target`, body: t.subject,
        link: `/service/tickets/${t.id}`, resourceType: 'ticket', resourceId: t.id, dedupeKey: `sla-resolution:${t.id}:${userId}`,
      });
    }
    await broadcastChange(t);
  }
  return { response: responses.length, resolution: resolutions.length };
}

/** Lookup for the reply email sent to a client by the outbox handler. */
export async function replyForEmail(ticketId: string, commentId: string) {
  return one<{ number: number; subject: string; company_id: string; requester_email: string; requester_name: string; requester_is_guest: number; body: string; author_name: string; visibility: string }>(
    `SELECT t.number, t.subject, t.company_id, ru.email AS requester_email, ru.display_name AS requester_name,
            ru.access_level = 'guest' AS requester_is_guest, c.body, au.display_name AS author_name, c.visibility
       FROM tickets t
       JOIN users ru ON ru.id = t.requester_id
       JOIN ticket_comments c ON c.id = $2 AND c.ticket_id = t.id
       JOIN users au ON au.id = c.author_id
      WHERE t.id = $1`,
    [ticketId, commentId],
  );
}

/* ------------------------------------------------------------------ deletion */

/** A queue with tickets keeps them (deactivate it instead); an unused one can go. */
export async function deleteQueue(actor: Actor, id: string) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const queue = await one<{ name: string }>('SELECT name FROM service_queues WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!queue) throw notFound('Queue not found');
  const used = await one<{ n: number }>('SELECT COUNT(*) AS n FROM tickets WHERE queue_id = $1', [id]);
  if (Number(used?.n)) throw conflict(`This queue has ${used!.n} ${Number(used!.n) === 1 ? 'ticket' : 'tickets'}. Deactivate it instead so their history stays.`);
  await pool.query('DELETE FROM service_queues WHERE id = $1', [id]);
  await auditFromActor(actor, 'service.queue.delete', { resourceType: 'service_queue', resourceId: id, metadata: { name: queue.name } });
}

export async function deleteCategory(actor: Actor, id: string) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const cat = await one<{ name: string }>('SELECT name FROM service_categories WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!cat) throw notFound('Category not found');
  const used = await one<{ n: number }>('SELECT COUNT(*) AS n FROM tickets WHERE category_id = $1', [id]);
  if (Number(used?.n)) throw conflict(`${used!.n} ${Number(used!.n) === 1 ? 'ticket uses' : 'tickets use'} this category. Deactivate it instead.`);
  await pool.query('DELETE FROM service_categories WHERE id = $1', [id]);
  await auditFromActor(actor, 'service.category.delete', { resourceType: 'service_category', resourceId: id, metadata: { name: cat.name } });
}

/**
 * Removes a ticket entirely - for spam and duplicates raised by mistake. Real requests are
 * closed, not deleted; the audit entry keeps the reference and subject.
 */
export async function deleteTicket(actor: Actor, id: string) {
  await authorize({ actor, capability: 'service.manage', resourceless: true });
  const t = await one<{ number: number; subject: string }>('SELECT number, subject FROM tickets WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!t) throw notFound('Ticket not found');
  if (await one('SELECT 1 FROM incidents WHERE problem_ticket_id = $1', [id])) throw conflict('This ticket is the problem record for an incident and cannot be deleted');
  await pool.query('DELETE FROM tickets WHERE id = $1', [id]);
  await searchIndex.remove('ticket', id);
  await auditFromActor(actor, 'ticket.delete', { resourceType: 'ticket', resourceId: id, metadata: { ref: `SD-${t.number}`, subject: t.subject } });
}
