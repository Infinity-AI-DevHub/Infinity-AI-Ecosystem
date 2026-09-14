/**
 * Access governance: which systems exist, who asked for access and why, who approved it,
 * who actually set it up, when it ends, whether it is still needed, and what has to be
 * taken away when someone leaves.
 *
 * Workspace records access; it does not reach into the systems themselves. A grant moves
 * pending_grant -> active only when the owner confirms they set it up, and
 * pending_removal -> removed only when they confirm it is gone. So the record is of what
 * was done, and anything approved-but-not-done stays visible as outstanding work.
 *
 * Requests route through the approvals engine: the requester's manager, then the
 * system's owner, then an administrator for high-risk systems.
 */
import { many, newId, one, parseJson, pool, transaction, type Queryable } from '../core/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import * as notifications from './notifications.js';

const DAY = 86_400_000;
type Risk = 'low' | 'medium' | 'high';
const RISK_SCORE: Record<Risk, number> = { low: 1, medium: 2, high: 3 };
type GrantStatus = 'pending_grant' | 'active' | 'pending_removal' | 'removed';

export const ACCESS_APPROVAL_DEFINITION = {
  key: 'access',
  name: 'Access request',
  formSchema: [{ field: 'resource', label: 'System', type: 'text' }, { field: 'role', label: 'Role', type: 'text' }],
  routing: [
    // Manager and owner are each skipped when there is none (or it is the requester);
    // the engine refuses a request that no step can approve.
    { step: 1, optional: true, approver: { type: 'manager' }, dueHours: 72 },
    { step: 2, optional: true, approver: { type: 'request_user', value: 'approverId', fallback: { type: 'access_level', value: 'admin' } }, dueHours: 72 },
    // A company run by its super administrator may have nobody at the admin level.
    { step: 3, minAmount: 3, approver: { type: 'access_level', value: 'admin', fallback: { type: 'access_level', value: 'super_admin' } }, dueHours: 72 },
  ],
};

const canManage = (actor: Actor) => hasCapability(actor, 'access.manage');
const canAudit = (actor: Actor) => hasCapability(actor, 'access.audit') || canManage(actor);

function requireEmployee(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
}

/** Pure: the grant's end date once it is set up. Exported for tests. */
export function grantExpiry(provisionedAt: Date, durationDays: number | null): Date | null {
  return durationDays ? new Date(provisionedAt.getTime() + durationDays * DAY) : null;
}

/** Pure: who reviews a grant. The owner, unless the owner holds it; then their manager; then whoever runs the review. */
export function reviewerFor(grant: { userId: string; ownerId: string | null; userManagerId: string | null }, reviewCreatorId: string): string {
  if (grant.ownerId && grant.ownerId !== grant.userId) return grant.ownerId;
  if (grant.userManagerId && grant.userManagerId !== grant.userId) return grant.userManagerId;
  return reviewCreatorId;
}

/* --------------------------------------------------------------- resources */

type ResourceRow = {
  id: string; company_id: string; name: string; description: string | null; kind: string; roles: unknown; risk: Risk; owner_id: string | null;
  service_id: string | null; max_days: number | null; required_course_id: string | null; is_active: number;
};

async function loadResource(actor: Actor, id: string, db: Queryable = pool) {
  requireEmployee(actor);
  const r = (await db.query<ResourceRow>('SELECT * FROM access_resources WHERE id = $1 AND company_id = $2', [id, actor.companyId])).rows[0];
  if (!r) throw notFound('System not found');
  return r;
}

const ownsOrManages = (actor: Actor, r: { owner_id: string | null }) => canManage(actor) || (r.owner_id !== null && r.owner_id === actor.userId);

export async function listResources(actor: Actor, filter: { includeInactive?: boolean }) {
  requireEmployee(actor);
  if (!hasCapability(actor, 'access.request') && !canAudit(actor)) throw forbidden();
  const rows = await many<ResourceRow & { owner_name: string | null; service_name: string | null; course_title: string | null; active_grants: number; my_roles: string | null }>(
    `SELECT r.*, u.display_name AS owner_name, s.name AS service_name, c.title AS course_title,
            (SELECT COUNT(*) FROM access_grants g WHERE g.resource_id = r.id AND g.status IN ('active','pending_removal')) AS active_grants,
            (SELECT GROUP_CONCAT(g.role SEPARATOR '||') FROM access_grants g WHERE g.resource_id = r.id AND g.user_id = $2 AND g.status IN ('pending_grant','active')) AS my_roles
       FROM access_resources r LEFT JOIN users u ON u.id = r.owner_id LEFT JOIN services s ON s.id = r.service_id LEFT JOIN courses c ON c.id = r.required_course_id
      WHERE r.company_id = $1 ${filter.includeInactive && canManage(actor) ? '' : 'AND r.is_active = 1'} ORDER BY r.name`, [actor.companyId, actor.userId]);
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, kind: r.kind, roles: parseJson<string[]>(r.roles, []), risk: r.risk, isActive: Boolean(r.is_active),
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : null, service: r.service_id ? { id: r.service_id, name: r.service_name } : null,
    maxDays: r.max_days, requiredCourse: r.required_course_id ? { id: r.required_course_id, title: r.course_title } : null,
    activeGrants: canAudit(actor) || r.owner_id === actor.userId ? Number(r.active_grants) : undefined,
    myRoles: r.my_roles ? r.my_roles.split('||') : [],
    canManage: ownsOrManages(actor, r),
  }));
}

type ResourceInput = { name: string; description?: string | null; kind: string; roles: string[]; risk: Risk; ownerId?: string | null; serviceId?: string | null; maxDays?: number | null; requiredCourseId?: string | null; isActive?: boolean };

export async function saveResource(actor: Actor, id: string | null, input: ResourceInput) {
  await authorize({ actor, capability: 'access.manage', resourceless: true });
  const roles = [...new Set(input.roles.map((r) => r.trim()).filter(Boolean))];
  if (roles.length === 0) throw unprocessable('Name at least one role people can be given', [{ field: 'roles', message: 'For example Viewer, Editor, Admin' }]);
  if (input.ownerId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active' AND access_level <> 'guest'", [input.ownerId, actor.companyId]))) throw unprocessable('Owner not found', [{ field: 'ownerId', message: 'Choose an active employee' }]);
  if (input.serviceId && !(await one('SELECT 1 FROM services WHERE id = $1 AND company_id = $2', [input.serviceId, actor.companyId]))) throw unprocessable('Service not found', [{ field: 'serviceId', message: 'Choose a service' }]);
  if (input.requiredCourseId && !(await one("SELECT 1 FROM courses WHERE id = $1 AND company_id = $2 AND status = 'published'", [input.requiredCourseId, actor.companyId]))) throw unprocessable('Course not found', [{ field: 'requiredCourseId', message: 'Choose a published course' }]);
  if (await one('SELECT 1 FROM access_resources WHERE company_id = $1 AND name = $2 AND id <> $3', [actor.companyId, input.name.trim(), id ?? ''])) throw conflict('A system with that name is already in the catalogue');
  const resourceId = id ?? newId();
  const values = [input.name.trim(), input.description?.trim() || null, input.kind, JSON.stringify(roles), input.risk, input.ownerId ?? null, input.serviceId ?? null, input.maxDays ?? null, input.requiredCourseId ?? null, input.isActive ?? true];
  if (id) {
    const res = await pool.query('UPDATE access_resources SET name = $3, description = $4, kind = $5, roles = $6, risk = $7, owner_id = $8, service_id = $9, max_days = $10, required_course_id = $11, is_active = $12 WHERE id = $1 AND company_id = $2', [id, actor.companyId, ...values]);
    if (res.rowCount === 0) throw notFound('System not found');
  } else {
    await pool.query('INSERT INTO access_resources (id, company_id, name, description, kind, roles, risk, owner_id, service_id, max_days, required_course_id, is_active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [resourceId, actor.companyId, ...values, actor.userId]);
  }
  await auditFromActor(actor, id ? 'access.resource.update' : 'access.resource.create', { resourceType: 'access_resource', resourceId, metadata: { risk: input.risk, owner: input.ownerId ?? null } });
  return { id: resourceId };
}

/* ---------------------------------------------------------------- requests */

async function ensureDefinition(companyId: string) {
  await pool.query(
    'INSERT IGNORE INTO approval_definitions (id, company_id, `key`, name, form_schema, routing) VALUES ($1,$2,\'access\',$3,$4,$5)',
    [newId(), companyId, ACCESS_APPROVAL_DEFINITION.name, JSON.stringify(ACCESS_APPROVAL_DEFINITION.formSchema), JSON.stringify(ACCESS_APPROVAL_DEFINITION.routing)]);
}

async function hasValidCompletion(userId: string, courseId: string) {
  const done = await one('SELECT 1 FROM enrolments WHERE user_id = $1 AND course_id = $2 AND status = \'completed\'', [userId, courseId]);
  if (!done) return false;
  const cert = await one<{ expires_at: Date | null }>('SELECT expires_at FROM certifications WHERE user_id = $1 AND course_id = $2 ORDER BY issued_at DESC LIMIT 1', [userId, courseId]);
  return !cert?.expires_at || new Date(cert.expires_at).getTime() > Date.now();
}

export async function requestAccess(actor: Actor, input: { resourceId: string; role: string; userId?: string | null; justification: string; durationDays?: number | null }, correlationId: string) {
  await authorize({ actor, capability: 'access.request', resourceless: true });
  const r = await loadResource(actor, input.resourceId);
  if (!r.is_active) throw conflict('This system is no longer in the catalogue');
  const beneficiary = input.userId ?? actor.userId;
  if (beneficiary !== actor.userId) {
    const report = await one<{ manager_id: string | null }>("SELECT manager_id FROM users WHERE id = $1 AND company_id = $2 AND status = 'active' AND access_level <> 'guest'", [beneficiary, actor.companyId]);
    if (!report) throw unprocessable('Person not found', [{ field: 'userId', message: 'Choose an active employee' }]);
    if (report.manager_id !== actor.userId && !canManage(actor)) throw forbidden('You can request access for yourself or for people who report to you');
  }
  if (!parseJson<string[]>(r.roles, []).includes(input.role)) throw unprocessable('That role does not exist for this system', [{ field: 'role', message: 'Choose a role' }]);
  if (r.max_days && (!input.durationDays || input.durationDays > r.max_days)) {
    throw unprocessable(`Access to ${r.name} is temporary: ask for ${r.max_days} days or fewer`, [{ field: 'durationDays', message: `At most ${r.max_days} days` }]);
  }
  if (r.required_course_id && !(await hasValidCompletion(beneficiary, r.required_course_id))) {
    const course = await one<{ title: string }>('SELECT title FROM courses WHERE id = $1', [r.required_course_id]);
    throw unprocessable(`${beneficiary === actor.userId ? 'Complete' : 'They need to complete'} "${course?.title ?? 'the required course'}" before asking for access to ${r.name}`, [{ field: 'resourceId', message: 'Training required' }]);
  }
  if (await one("SELECT 1 FROM access_grants WHERE resource_id = $1 AND user_id = $2 AND role = $3 AND status IN ('pending_grant','active')", [r.id, beneficiary, input.role])) throw conflict('That access is already granted');
  if (await one("SELECT 1 FROM access_requests WHERE resource_id = $1 AND user_id = $2 AND role = $3 AND status = 'pending'", [r.id, beneficiary, input.role])) throw conflict('A request for that access is already waiting for approval');

  await ensureDefinition(actor.companyId);
  const person = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [beneficiary]);
  const id = newId();
  const number = Number((await one<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM access_requests WHERE company_id = $1', [actor.companyId]))?.n ?? 1);
  const { createRequest } = await import('./approvals.js');
  let approval;
  try {
    approval = await createRequest(actor, {
      definitionKey: 'access',
      title: `ACC-${number}: ${r.name} (${input.role}) for ${person?.display_name ?? 'someone'}`.slice(0, 200),
      amount: RISK_SCORE[r.risk],
      data: { accessRequestId: id, approverId: r.owner_id, resource: r.name, role: input.role, userId: beneficiary, durationDays: input.durationDays ?? null, justification: input.justification },
    }, correlationId);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 422 && /cannot be routed/.test((err as Error).message)) {
      throw unprocessable('Nobody can approve this request yet. It needs your manager, the system owner, or another active administrator.', [{ field: 'approval', message: 'Set an owner for the system, or a manager on your profile.' }]);
    }
    throw err;
  }
  await transaction(async (tx) => {
    await tx.query('INSERT INTO access_requests (id, company_id, number, resource_id, role, requester_id, user_id, justification, duration_days, approval_request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, actor.companyId, number, r.id, input.role, actor.userId, beneficiary, input.justification.trim(), input.durationDays ?? null, approval.id]);
    await auditFromActor(actor, 'access.request', { resourceType: 'access_request', resourceId: id, metadata: { resourceId: r.id, role: input.role, userId: beneficiary, durationDays: input.durationDays ?? null } }, tx);
  });
  return { id, ref: `ACC-${number}`, approvalRequestId: approval.id };
}

/** Called by the outbox when the approval behind an access request completes. */
export async function settleDecision(requestId: string, status: 'approved' | 'rejected') {
  const req = await one<{ id: string; company_id: string; number: number; resource_id: string; role: string; user_id: string; requester_id: string; status: string }>('SELECT * FROM access_requests WHERE id = $1', [requestId]);
  if (!req || req.status !== 'pending') return;
  const r = (await one<ResourceRow>('SELECT * FROM access_resources WHERE id = $1', [req.resource_id]))!;
  let grantId: string | null = null;
  await transaction(async (tx) => {
    const claimed = await tx.query("UPDATE access_requests SET status = $2, decided_at = NOW(3) WHERE id = $1 AND status = 'pending'", [requestId, status]);
    if (!claimed.rowCount) return;
    if (status === 'approved') {
      grantId = newId();
      await tx.query("INSERT INTO access_grants (id, company_id, resource_id, role, user_id, status, source, request_id) VALUES ($1,$2,$3,$4,$5,'pending_grant','request',$6)", [grantId, req.company_id, req.resource_id, req.role, req.user_id, requestId]);
      await tx.query('UPDATE access_requests SET grant_id = $2 WHERE id = $1', [requestId, grantId]);
    }
  });
  const ref = `ACC-${req.number}`;
  for (const userId of new Set([req.user_id, req.requester_id])) {
    await notifications.create({
      companyId: req.company_id, userId, type: status === 'approved' ? 'access.approved' : 'access.rejected',
      title: `${ref}: access to ${r.name} was ${status}`, body: status === 'approved' ? 'The owner will confirm once it is set up.' : undefined,
      link: '/access', resourceType: 'access_request', resourceId: requestId, dedupeKey: `access.decided:${requestId}:${userId}`,
    });
  }
  if (grantId) await notifyOwner(req.company_id, r, `Set up ${r.name} (${req.role}) for ${ref}`, grantId, 'grant');
}

async function notifyOwner(companyId: string, r: ResourceRow, title: string, grantId: string, kind: 'grant' | 'removal') {
  // An owner never carries out a change to their own access; administrators do.
  const holder = await one<{ user_id: string }>('SELECT user_id FROM access_grants WHERE id = $1', [grantId]);
  const recipients = r.owner_id && r.owner_id !== holder?.user_id ? [r.owner_id] : (await many<{ id: string }>("SELECT id FROM users WHERE company_id = $1 AND access_level IN ('admin','super_admin') AND status = 'active'", [companyId])).map((u) => u.id);
  for (const userId of recipients) {
    await notifications.create({ companyId, userId, type: kind === 'grant' ? 'access.provision' : 'access.deprovision', title, link: '/access/grants?view=todo', resourceType: 'access_grant', resourceId: grantId, dedupeKey: `access.${kind}:${grantId}:${userId}` });
  }
}

export async function cancelRequest(actor: Actor, id: string) {
  requireEmployee(actor);
  const req = await one<{ requester_id: string; status: string; approval_request_id: string | null }>('SELECT requester_id, status, approval_request_id FROM access_requests WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!req) throw notFound('Request not found');
  if (req.requester_id !== actor.userId) throw forbidden('Only the person who asked can withdraw a request');
  if (req.status !== 'pending') throw conflict(`This request is already ${req.status}`);
  if (req.approval_request_id) {
    const { cancelRequest: cancelApproval } = await import('./approvals.js');
    await cancelApproval(actor, req.approval_request_id);
  }
  await pool.query("UPDATE access_requests SET status = 'cancelled', decided_at = NOW(3) WHERE id = $1", [id]);
  await auditFromActor(actor, 'access.request.cancel', { resourceType: 'access_request', resourceId: id });
}

export async function listRequests(actor: Actor, filter: { scope: 'mine' | 'all'; status?: string; limit: number }) {
  requireEmployee(actor);
  if (filter.scope === 'all' && !canAudit(actor)) throw forbidden();
  const params: unknown[] = [actor.companyId];
  const where = ['q.company_id = $1'];
  if (filter.scope === 'mine') { params.push(actor.userId); where.push(`(q.requester_id = $${params.length} OR q.user_id = $${params.length})`); }
  if (filter.status) { params.push(filter.status); where.push(`q.status = $${params.length}`); }
  const rows = await many<{ id: string; number: number; resource_id: string; resource_name: string; risk: string; role: string; user_id: string; user_name: string; requester_id: string; requester_name: string; justification: string; duration_days: number | null; status: string; approval_request_id: string | null; approval_ref: string | null; created_at: Date; decided_at: Date | null; grant_status: string | null }>(
    `SELECT q.*, r.name AS resource_name, r.risk, u.display_name AS user_name, rq.display_name AS requester_name, ar.reference AS approval_ref, g.status AS grant_status
       FROM access_requests q JOIN access_resources r ON r.id = q.resource_id JOIN users u ON u.id = q.user_id JOIN users rq ON rq.id = q.requester_id
       LEFT JOIN approval_requests ar ON ar.id = q.approval_request_id LEFT JOIN access_grants g ON g.id = q.grant_id
      WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT $${params.length + 1}`, [...params, filter.limit]);
  return rows.map((q) => ({
    id: q.id, ref: `ACC-${q.number}`, resource: { id: q.resource_id, name: q.resource_name, risk: q.risk }, role: q.role,
    user: { id: q.user_id, name: q.user_name }, requester: { id: q.requester_id, name: q.requester_name }, justification: q.justification,
    durationDays: q.duration_days, status: q.status, approval: q.approval_request_id ? { id: q.approval_request_id, ref: q.approval_ref } : null,
    grantStatus: q.grant_status, createdAt: q.created_at, decidedAt: q.decided_at, canCancel: q.status === 'pending' && q.requester_id === actor.userId,
  }));
}

/* ------------------------------------------------------------------ grants */

type GrantRow = { id: string; company_id: string; resource_id: string; role: string; user_id: string; status: GrantStatus; source: string; request_id: string | null; expires_at: Date | null; provisioned_at: Date | null };

async function loadGrant(actor: Actor, id: string) {
  requireEmployee(actor);
  const g = await one<GrantRow & { owner_id: string | null; resource_name: string; duration_days: number | null }>(
    `SELECT g.*, r.owner_id, r.name AS resource_name, q.duration_days FROM access_grants g JOIN access_resources r ON r.id = g.resource_id LEFT JOIN access_requests q ON q.id = g.request_id
      WHERE g.id = $1 AND g.company_id = $2`, [id, actor.companyId]);
  if (!g) throw notFound('Grant not found');
  return g;
}

export async function listGrants(actor: Actor, filter: { view: 'mine' | 'todo' | 'all'; resourceId?: string; userId?: string; status?: GrantStatus; limit: number }) {
  requireEmployee(actor);
  const params: unknown[] = [actor.companyId];
  const where = ['g.company_id = $1'];
  if (filter.view === 'mine') { params.push(actor.userId); where.push(`g.user_id = $${params.length}`); }
  if (filter.view === 'todo') {
    // Work waiting on this person: set-ups and removals for systems they own (or any, for access managers).
    where.push("g.status IN ('pending_grant','pending_removal')");
    if (!canManage(actor)) { params.push(actor.userId); where.push(`r.owner_id = $${params.length} AND g.user_id <> $${params.length}`); }
  }
  if (filter.view === 'all' && !canAudit(actor)) { params.push(actor.userId); where.push(`r.owner_id = $${params.length}`); }
  if (filter.resourceId) { params.push(filter.resourceId); where.push(`g.resource_id = $${params.length}`); }
  if (filter.userId) { params.push(filter.userId); where.push(`g.user_id = $${params.length}`); }
  if (filter.status) { params.push(filter.status); where.push(`g.status = $${params.length}`); }
  const rows = await many<GrantRow & { resource_name: string; risk: string; owner_id: string | null; user_name: string; user_status: string; number: number | null; removal_reason: string | null; removal_note: string | null; removal_requested_at: Date | null; removed_at: Date | null; created_at: Date; provisioner: string | null }>(
    `SELECT g.*, r.name AS resource_name, r.risk, r.owner_id, u.display_name AS user_name, u.status AS user_status, q.number, p.display_name AS provisioner
       FROM access_grants g JOIN access_resources r ON r.id = g.resource_id JOIN users u ON u.id = g.user_id
       LEFT JOIN access_requests q ON q.id = g.request_id LEFT JOIN users p ON p.id = g.provisioned_by
      WHERE ${where.join(' AND ')}
      ORDER BY FIELD(g.status,'pending_removal','pending_grant','active','removed'), g.expires_at IS NULL, g.expires_at, g.created_at DESC
      LIMIT $${params.length + 1}`, [...params, filter.limit]);
  return rows.map((g) => ({
    id: g.id, resource: { id: g.resource_id, name: g.resource_name, risk: g.risk }, role: g.role, user: { id: g.user_id, name: g.user_name, status: g.user_status },
    status: g.status, source: g.source, requestRef: g.number ? `ACC-${g.number}` : null, expiresAt: g.expires_at, provisionedAt: g.provisioned_at, provisionedBy: g.provisioner,
    removalReason: g.removal_reason, removalNote: g.removal_note, removalRequestedAt: g.removal_requested_at, removedAt: g.removed_at, createdAt: g.created_at,
    canAct: canManage(actor) || (g.owner_id === actor.userId && g.user_id !== actor.userId),
  }));
}

/** The owner confirms they set the access up. A temporary grant's clock starts now. */
export async function confirmGrant(actor: Actor, id: string) {
  const g = await loadGrant(actor, id);
  if (!ownsOrManages(actor, g)) throw forbidden('Only the system owner or an access manager can confirm this');
  if (g.user_id === actor.userId && !canManage(actor)) throw forbidden('Someone else must confirm access given to you');
  if (g.status !== 'pending_grant') throw conflict('This access is not waiting to be set up');
  const now = new Date();
  await pool.query("UPDATE access_grants SET status = 'active', provisioned_at = $2, provisioned_by = $3, expires_at = $4 WHERE id = $1", [id, now, actor.userId, grantExpiry(now, g.duration_days)]);
  await auditFromActor(actor, 'access.grant.confirm', { resourceType: 'access_grant', resourceId: id, metadata: { userId: g.user_id, resourceId: g.resource_id, role: g.role } });
  await notifications.create({ companyId: g.company_id, userId: g.user_id, type: 'access.granted', title: `Your access to ${g.resource_name} is ready`, body: g.duration_days ? `It ends in ${g.duration_days} days` : undefined, link: '/access', resourceType: 'access_grant', resourceId: id, dedupeKey: `access.granted:${id}` });
}

async function startRemoval(companyId: string, g: GrantRow, reason: 'expired' | 'review' | 'revoked' | 'offboarding', note: string | null, db: Queryable = pool) {
  // Access that was approved but never set up has nothing to take away.
  if (g.status === 'pending_grant') {
    await db.query("UPDATE access_grants SET status = 'removed', removal_reason = $2, removal_note = $3, removal_requested_at = NOW(3), removed_at = NOW(3) WHERE id = $1", [g.id, reason, note]);
    return 'removed' as const;
  }
  if (g.status !== 'active') return null;
  await db.query("UPDATE access_grants SET status = 'pending_removal', removal_reason = $2, removal_note = $3, removal_requested_at = NOW(3) WHERE id = $1", [g.id, reason, note]);
  return 'pending_removal' as const;
}

export async function revokeGrant(actor: Actor, id: string, note: string) {
  const g = await loadGrant(actor, id);
  if (!ownsOrManages(actor, g)) throw forbidden('Only the system owner or an access manager can revoke access');
  const result = await startRemoval(g.company_id, g, 'revoked', note.trim() || null);
  if (!result) throw conflict('This access is not active');
  await auditFromActor(actor, 'access.grant.revoke', { resourceType: 'access_grant', resourceId: id, metadata: { userId: g.user_id, resourceId: g.resource_id, role: g.role, note } });
  if (result === 'pending_removal') {
    const r = (await one<ResourceRow>('SELECT * FROM access_resources WHERE id = $1', [g.resource_id]))!;
    await notifyOwner(g.company_id, r, `Remove ${r.name} (${g.role}) access: revoked`, id, 'removal');
  }
}

/** The owner confirms the access is gone from the system. */
export async function confirmRemoval(actor: Actor, id: string) {
  const g = await loadGrant(actor, id);
  if (!ownsOrManages(actor, g)) throw forbidden('Only the system owner or an access manager can confirm this');
  if (g.user_id === actor.userId && !canManage(actor)) throw forbidden('Someone else must confirm your own access was removed');
  if (g.status !== 'pending_removal') throw conflict('This access is not waiting to be removed');
  await transaction(async (tx) => {
    await tx.query("UPDATE access_grants SET status = 'removed', removed_at = NOW(3), removed_by = $2 WHERE id = $1", [id, actor.userId]);
    // An offboarding task for this grant is the same piece of work.
    await tx.query("UPDATE offboarding_tasks SET done_at = NOW(3), done_by = $2 WHERE kind = 'access' AND reference_id = $1 AND done_at IS NULL", [id, actor.userId]);
    await auditFromActor(actor, 'access.grant.removed', { resourceType: 'access_grant', resourceId: id, metadata: { userId: g.user_id, resourceId: g.resource_id, role: g.role } }, tx);
  });
}

/** Records access someone already has, so it can be reviewed. Access managers only. */
export async function recordExistingGrant(actor: Actor, input: { resourceId: string; role: string; userId: string; expiresAt?: string | null; note?: string | null }) {
  await authorize({ actor, capability: 'access.manage', resourceless: true });
  const r = await loadResource(actor, input.resourceId);
  if (!parseJson<string[]>(r.roles, []).includes(input.role)) throw unprocessable('That role does not exist for this system', [{ field: 'role', message: 'Choose a role' }]);
  if (!(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND access_level <> 'guest'", [input.userId, actor.companyId]))) throw unprocessable('Person not found', [{ field: 'userId', message: 'Choose an employee' }]);
  if (await one("SELECT 1 FROM access_grants WHERE resource_id = $1 AND user_id = $2 AND role = $3 AND status IN ('pending_grant','active')", [r.id, input.userId, input.role])) throw conflict('That access is already recorded');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw unprocessable('The end date must be in the future', [{ field: 'expiresAt', message: 'Check the date' }]);
  const id = newId();
  await pool.query("INSERT INTO access_grants (id, company_id, resource_id, role, user_id, status, source, granted_by, provisioned_at, provisioned_by, expires_at) VALUES ($1,$2,$3,$4,$5,'active','manual',$6,NOW(3),$6,$7)",
    [id, actor.companyId, r.id, input.role, input.userId, actor.userId, expiresAt]);
  await auditFromActor(actor, 'access.grant.record', { resourceType: 'access_grant', resourceId: id, metadata: { userId: input.userId, resourceId: r.id, role: input.role, note: input.note ?? null } });
  return { id };
}

/** Temporary access ends on time: expired grants become removals for the owner, and holders hear three days ahead. */
export async function expireGrants(): Promise<number> {
  const soon = await many<GrantRow & { resource_name: string }>(
    `SELECT g.*, r.name AS resource_name FROM access_grants g JOIN access_resources r ON r.id = g.resource_id
      WHERE g.status = 'active' AND g.expires_at IS NOT NULL AND g.expires_at > NOW(3) AND g.expires_at < DATE_ADD(NOW(3), INTERVAL 3 DAY) AND g.expiry_reminded_at IS NULL LIMIT 500`);
  for (const g of soon) {
    await notifications.create({ companyId: g.company_id, userId: g.user_id, type: 'access.expiring', title: `Your ${g.resource_name} access ends ${new Date(g.expires_at!).toISOString().slice(0, 10)}`, body: 'Ask again if you still need it.', link: '/access', resourceType: 'access_grant', resourceId: g.id, dedupeKey: `access.expiring:${g.id}` });
    await pool.query('UPDATE access_grants SET expiry_reminded_at = NOW(3) WHERE id = $1', [g.id]);
  }
  const expired = await many<GrantRow>("SELECT * FROM access_grants WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW(3) LIMIT 500");
  for (const g of expired) {
    const result = await startRemoval(g.company_id, g, 'expired', null);
    if (result !== 'pending_removal') continue;
    const r = (await one<ResourceRow>('SELECT * FROM access_resources WHERE id = $1', [g.resource_id]))!;
    const who = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [g.user_id]);
    await notifyOwner(g.company_id, r, `Remove ${r.name} (${g.role}) from ${who?.display_name ?? 'someone'}: temporary access ended`, g.id, 'removal');
    await notifications.create({ companyId: g.company_id, userId: g.user_id, type: 'access.expired', title: `Your ${r.name} access has ended`, link: '/access', resourceType: 'access_grant', resourceId: g.id, dedupeKey: `access.expired:${g.id}` });
  }
  return expired.length;
}

/* ----------------------------------------------------------------- reviews */

export async function createReview(actor: Actor, input: { name: string; resourceId?: string | null; dueAt: string }) {
  await authorize({ actor, capability: 'access.manage', resourceless: true });
  if (input.resourceId) await loadResource(actor, input.resourceId);
  const dueAt = new Date(input.dueAt);
  if (dueAt.getTime() <= Date.now()) throw unprocessable('The due date must be in the future', [{ field: 'dueAt', message: 'Choose a later date' }]);
  const grants = await many<{ id: string; user_id: string; owner_id: string | null; manager_id: string | null }>(
    `SELECT g.id, g.user_id, r.owner_id, u.manager_id FROM access_grants g JOIN access_resources r ON r.id = g.resource_id JOIN users u ON u.id = g.user_id
      WHERE g.company_id = $1 AND g.status = 'active' ${input.resourceId ? 'AND g.resource_id = $2' : ''}`, input.resourceId ? [actor.companyId, input.resourceId] : [actor.companyId]);
  if (grants.length === 0) throw unprocessable('There is no active access to review', [{ field: 'resourceId', message: 'Choose a system with active access' }]);
  const id = newId();
  const reviewers = new Set<string>();
  await transaction(async (tx) => {
    await tx.query('INSERT INTO access_reviews (id, company_id, name, resource_id, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, actor.companyId, input.name.trim(), input.resourceId ?? null, dueAt, actor.userId]);
    for (const g of grants) {
      const reviewer = reviewerFor({ userId: g.user_id, ownerId: g.owner_id, userManagerId: g.manager_id }, actor.userId);
      reviewers.add(reviewer);
      await tx.query('INSERT INTO access_review_items (id, review_id, grant_id, reviewer_id) VALUES ($1,$2,$3,$4)', [newId(), id, g.id, reviewer]);
    }
    await auditFromActor(actor, 'access.review.create', { resourceType: 'access_review', resourceId: id, metadata: { items: grants.length } }, tx);
  });
  for (const userId of reviewers) {
    await notifications.create({ companyId: actor.companyId, userId, type: 'access.review', title: `Access review: ${input.name.trim()}`, body: `Confirm who still needs access by ${dueAt.toISOString().slice(0, 10)}`, link: `/access/reviews/${id}`, resourceType: 'access_review', resourceId: id, dedupeKey: `access.review:${id}:${userId}` });
  }
  return { id, items: grants.length };
}

export async function listReviews(actor: Actor) {
  requireEmployee(actor);
  const all = canAudit(actor);
  const rows = await many<{ id: string; name: string; resource_name: string | null; due_at: Date; status: string; created_at: Date; closed_at: Date | null; total: number; decided: number; revoked: number; mine: number; mine_open: number }>(
    `SELECT v.id, v.name, r.name AS resource_name, v.due_at, v.status, v.created_at, v.closed_at,
            COUNT(i.id) AS total, SUM(i.decision IS NOT NULL) AS decided, SUM(i.decision = 'revoke') AS revoked,
            SUM(i.reviewer_id = $2) AS mine, SUM(i.reviewer_id = $2 AND i.decision IS NULL) AS mine_open
       FROM access_reviews v LEFT JOIN access_resources r ON r.id = v.resource_id LEFT JOIN access_review_items i ON i.review_id = v.id
      WHERE v.company_id = $1 GROUP BY v.id, v.name, r.name, v.due_at, v.status, v.created_at, v.closed_at
      ${all ? '' : 'HAVING SUM(i.reviewer_id = $2) > 0'} ORDER BY v.status = 'closed', v.due_at`, [actor.companyId, actor.userId]);
  return rows.map((v) => ({ id: v.id, name: v.name, scope: v.resource_name ?? 'All systems', dueAt: v.due_at, status: v.status, createdAt: v.created_at, closedAt: v.closed_at, total: Number(v.total), decided: Number(v.decided ?? 0), revoked: Number(v.revoked ?? 0), mine: Number(v.mine ?? 0), mineOpen: Number(v.mine_open ?? 0), overdue: v.status === 'open' && new Date(v.due_at).getTime() < Date.now() }));
}

export async function getReview(actor: Actor, id: string) {
  requireEmployee(actor);
  const v = await one<{ id: string; name: string; resource_id: string | null; due_at: Date; status: string; created_by: string | null }>('SELECT * FROM access_reviews WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!v) throw notFound('Review not found');
  const all = canAudit(actor);
  const items = await many<{ id: string; grant_id: string; reviewer_id: string | null; reviewer_name: string | null; decision: string | null; note: string | null; decided_at: Date | null; resource_name: string; role: string; user_id: string; user_name: string; user_status: string; provisioned_at: Date | null; expires_at: Date | null; grant_status: string; last_login: Date | null }>(
    `SELECT i.*, rv.display_name AS reviewer_name, r.name AS resource_name, g.role, g.user_id, u.display_name AS user_name, u.status AS user_status,
            g.provisioned_at, g.expires_at, g.status AS grant_status,
            (SELECT MAX(x.last_seen_at) FROM sessions x WHERE x.user_id = g.user_id) AS last_login
       FROM access_review_items i JOIN access_grants g ON g.id = i.grant_id JOIN access_resources r ON r.id = g.resource_id JOIN users u ON u.id = g.user_id
       LEFT JOIN users rv ON rv.id = i.reviewer_id
      WHERE i.review_id = $1 ${all ? '' : 'AND i.reviewer_id = $2'} ORDER BY i.decision IS NOT NULL, r.name, u.display_name`, all ? [id] : [id, actor.userId]);
  if (!all && items.length === 0) throw notFound('Review not found');
  return {
    id: v.id, name: v.name, dueAt: v.due_at, status: v.status,
    items: items.map((i) => ({
      id: i.id, grantId: i.grant_id, resource: i.resource_name, role: i.role, user: { id: i.user_id, name: i.user_name, status: i.user_status, lastLoginAt: i.last_login },
      grantedAt: i.provisioned_at, expiresAt: i.expires_at, grantStatus: i.grant_status, reviewer: i.reviewer_name, decision: i.decision, note: i.note, decidedAt: i.decided_at,
      canDecide: v.status === 'open' && i.decision === null && i.user_id !== actor.userId && (i.reviewer_id === actor.userId || canManage(actor)),
    })),
    permissions: { canClose: canManage(actor) && v.status === 'open' },
  };
}

export async function decideReviewItem(actor: Actor, itemId: string, input: { decision: 'keep' | 'revoke'; note?: string | null }) {
  requireEmployee(actor);
  const i = await one<{ id: string; review_id: string; grant_id: string; reviewer_id: string | null; decision: string | null; review_status: string; company_id: string }>(
    'SELECT i.*, v.status AS review_status, v.company_id FROM access_review_items i JOIN access_reviews v ON v.id = i.review_id WHERE i.id = $1 AND v.company_id = $2', [itemId, actor.companyId]);
  if (!i) throw notFound('Review item not found');
  if (i.review_status !== 'open') throw conflict('This review is closed');
  if (i.decision) throw conflict('This access has already been reviewed');
  const g = (await one<GrantRow & { resource_name: string }>('SELECT g.*, r.name AS resource_name FROM access_grants g JOIN access_resources r ON r.id = g.resource_id WHERE g.id = $1', [i.grant_id]))!;
  if (g.user_id === actor.userId) throw forbidden('You cannot review your own access');
  if (i.reviewer_id !== actor.userId && !canManage(actor)) throw forbidden('This item is assigned to another reviewer');
  if (input.decision === 'revoke' && !input.note?.trim()) throw unprocessable('Say why the access should be removed', [{ field: 'note', message: 'Required when revoking' }]);
  let removal: 'removed' | 'pending_removal' | null = null;
  await transaction(async (tx) => {
    await tx.query('UPDATE access_review_items SET decision = $2, note = $3, decided_at = NOW(3), reviewer_id = $4 WHERE id = $1', [itemId, input.decision, input.note?.trim() || null, actor.userId]);
    if (input.decision === 'revoke') removal = await startRemoval(g.company_id, g, 'review', input.note?.trim() ?? null, tx);
    await auditFromActor(actor, `access.review.${input.decision}`, { resourceType: 'access_grant', resourceId: g.id, metadata: { reviewId: i.review_id, userId: g.user_id } }, tx);
  });
  if (removal === 'pending_removal') {
    const r = (await one<ResourceRow>('SELECT * FROM access_resources WHERE id = $1', [g.resource_id]))!;
    await notifyOwner(g.company_id, r, `Remove ${r.name} (${g.role}) access: revoked in review`, g.id, 'removal');
  }
}

export async function closeReview(actor: Actor, id: string) {
  await authorize({ actor, capability: 'access.manage', resourceless: true });
  const open = await one<{ n: number }>('SELECT COUNT(*) AS n FROM access_review_items i JOIN access_reviews v ON v.id = i.review_id WHERE v.id = $1 AND v.company_id = $2 AND i.decision IS NULL', [id, actor.companyId]);
  if (Number(open?.n)) throw conflict(`${open!.n} ${Number(open!.n) === 1 ? 'grant has' : 'grants have'} not been reviewed yet`);
  const res = await pool.query("UPDATE access_reviews SET status = 'closed', closed_at = NOW(3) WHERE id = $1 AND company_id = $2 AND status = 'open'", [id, actor.companyId]);
  if (res.rowCount === 0) throw conflict('This review is not open');
  await auditFromActor(actor, 'access.review.close', { resourceType: 'access_review', resourceId: id });
}

/* ------------------------------------------------------------- offboarding */

/**
 * Runs after someone is offboarded (identity.offboardUser emits the event). Their access
 * becomes removal work for each system's owner, equipment they hold becomes collection
 * work, and what they owned in the catalogue and the academy moves to their successor.
 */
export async function onOffboarded(payload: { userId: string; successorId: string | null }) {
  const user = await one<{ company_id: string; display_name: string }>('SELECT company_id, display_name FROM users WHERE id = $1', [payload.userId]);
  if (!user) return;
  const off = await one<{ id: string; performed_by: string | null }>('SELECT id, performed_by FROM offboardings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [payload.userId]);
  if (!off) return;
  const companyId = user.company_id;
  const fallbackAssignee = off.performed_by;

  const grants = await many<GrantRow & { owner_id: string | null; resource_name: string }>(
    "SELECT g.*, r.owner_id, r.name AS resource_name FROM access_grants g JOIN access_resources r ON r.id = g.resource_id WHERE g.user_id = $1 AND g.status IN ('pending_grant','active','pending_removal')", [payload.userId]);
  for (const g of grants) {
    const result = g.status === 'pending_removal' ? 'pending_removal' : await startRemoval(companyId, g, 'offboarding', null);
    if (result === 'pending_removal') {
      await pool.query("INSERT IGNORE INTO offboarding_tasks (id, company_id, offboarding_id, kind, title, reference_id, assignee_id) VALUES ($1,$2,$3,'access',$4,$5,$6)",
        [newId(), companyId, off.id, `Remove ${g.resource_name} (${g.role})`, g.id, (g.owner_id && g.owner_id !== payload.userId ? g.owner_id : payload.successorId) ?? fallbackAssignee]);
      const r = (await one<ResourceRow>('SELECT * FROM access_resources WHERE id = $1', [g.resource_id]))!;
      await notifyOwner(companyId, r, `Remove ${r.name} (${g.role}) from ${user.display_name}: offboarded`, g.id, 'removal');
    }
  }
  await pool.query("UPDATE access_requests SET status = 'cancelled', decided_at = NOW(3) WHERE user_id = $1 AND status = 'pending'", [payload.userId]);

  const assets = await many<{ id: string; asset_tag: string; name: string }>("SELECT id, asset_tag, name FROM assets WHERE company_id = $1 AND assigned_to = $2 AND status = 'assigned'", [companyId, payload.userId]);
  for (const a of assets) {
    await pool.query("INSERT IGNORE INTO offboarding_tasks (id, company_id, offboarding_id, kind, title, reference_id, assignee_id) VALUES ($1,$2,$3,'asset',$4,$5,$6)",
      [newId(), companyId, off.id, `Collect ${a.asset_tag} ${a.name}`, a.id, fallbackAssignee]);
  }

  if (payload.successorId) {
    await pool.query('UPDATE services SET owner_user_id = $3 WHERE company_id = $1 AND owner_user_id = $2', [companyId, payload.userId, payload.successorId]);
    await pool.query('UPDATE access_resources SET owner_id = $3 WHERE company_id = $1 AND owner_id = $2', [companyId, payload.userId, payload.successorId]);
    const { transferOwnership } = await import('./academy.js');
    await transferOwnership(companyId, payload.userId, payload.successorId);
  }
  // Review items they were due to decide go to whoever runs the review.
  await pool.query(
    `UPDATE access_review_items i JOIN access_reviews v ON v.id = i.review_id SET i.reviewer_id = COALESCE($2, v.created_by)
      WHERE i.reviewer_id = $1 AND i.decision IS NULL AND v.status = 'open'`, [payload.userId, payload.successorId]);
}

export async function listOffboardings(actor: Actor) {
  requireEmployee(actor);
  if (!hasCapability(actor, 'user.suspend') && !canAudit(actor)) throw forbidden();
  const rows = await many<{ id: string; user_id: string; user_name: string; successor_name: string | null; performer: string | null; reason: string; last_day: Date | null; created_at: Date; total: number; done: number }>(
    `SELECT o.id, o.user_id, u.display_name AS user_name, s.display_name AS successor_name, p.display_name AS performer, o.reason, o.last_day, o.created_at,
            (SELECT COUNT(*) FROM offboarding_tasks t WHERE t.offboarding_id = o.id) AS total,
            (SELECT COUNT(*) FROM offboarding_tasks t WHERE t.offboarding_id = o.id AND t.done_at IS NOT NULL) AS done
       FROM offboardings o JOIN users u ON u.id = o.user_id LEFT JOIN users s ON s.id = o.successor_id LEFT JOIN users p ON p.id = o.performed_by
      WHERE o.company_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [actor.companyId]);
  return rows.map((o) => ({ id: o.id, user: { id: o.user_id, name: o.user_name }, successor: o.successor_name, performedBy: o.performer, reason: o.reason, lastDay: o.last_day, createdAt: o.created_at, tasks: Number(o.total), done: Number(o.done) }));
}

/** Tasks assigned to this person across every offboarding, or all tasks of one offboarding. */
export async function listOffboardingTasks(actor: Actor, filter: { offboardingId?: string; mine?: boolean }) {
  requireEmployee(actor);
  const oversee = hasCapability(actor, 'user.suspend') || canAudit(actor);
  const params: unknown[] = [actor.companyId];
  const where = ['t.company_id = $1'];
  if (filter.offboardingId) { params.push(filter.offboardingId); where.push(`t.offboarding_id = $${params.length}`); }
  if (filter.mine || !oversee) { params.push(actor.userId); where.push(`t.assignee_id = $${params.length}`); }
  const rows = await many<{ id: string; offboarding_id: string; kind: string; title: string; reference_id: string | null; assignee_id: string | null; assignee_name: string | null; done_at: Date | null; done_by_name: string | null; leaver: string; grant_status: string | null }>(
    `SELECT t.*, a.display_name AS assignee_name, d.display_name AS done_by_name, u.display_name AS leaver, g.status AS grant_status
       FROM offboarding_tasks t JOIN offboardings o ON o.id = t.offboarding_id JOIN users u ON u.id = o.user_id
       LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users d ON d.id = t.done_by LEFT JOIN access_grants g ON g.id = t.reference_id AND t.kind = 'access'
      WHERE ${where.join(' AND ')} ORDER BY t.done_at IS NOT NULL, t.created_at LIMIT 500`, params);
  return rows.map((t) => ({
    id: t.id, offboardingId: t.offboarding_id, kind: t.kind, title: t.title, leaver: t.leaver, assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name } : null,
    doneAt: t.done_at, doneBy: t.done_by_name, canComplete: !t.done_at && (t.assignee_id === actor.userId || hasCapability(actor, 'user.suspend') || canManage(actor)),
  }));
}

export async function addOffboardingTask(actor: Actor, offboardingId: string, input: { title: string; assigneeId?: string | null }) {
  await authorize({ actor, capability: 'user.suspend', resourceless: true });
  if (!(await one('SELECT 1 FROM offboardings WHERE id = $1 AND company_id = $2', [offboardingId, actor.companyId]))) throw notFound('Offboarding not found');
  if (input.assigneeId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'", [input.assigneeId, actor.companyId]))) throw unprocessable('Person not found', [{ field: 'assigneeId', message: 'Choose an active person' }]);
  const id = newId();
  await pool.query("INSERT INTO offboarding_tasks (id, company_id, offboarding_id, kind, title, reference_id, assignee_id) VALUES ($1,$2,$3,'custom',$4,$5,$6)", [id, actor.companyId, offboardingId, input.title.trim(), id, input.assigneeId ?? actor.userId]);
  await auditFromActor(actor, 'offboarding.task.add', { resourceType: 'offboarding', resourceId: offboardingId });
  if (input.assigneeId && input.assigneeId !== actor.userId) {
    await notifications.create({ companyId: actor.companyId, userId: input.assigneeId, type: 'offboarding.task', title: `Offboarding task: ${input.title.trim()}`, link: '/access/offboarding', resourceType: 'offboarding', resourceId: offboardingId, dedupeKey: `offboarding.task:${id}` });
  }
  return { id };
}

export async function completeOffboardingTask(actor: Actor, taskId: string) {
  requireEmployee(actor);
  const t = await one<{ id: string; kind: string; reference_id: string | null; assignee_id: string | null; done_at: Date | null; offboarding_id: string }>('SELECT * FROM offboarding_tasks WHERE id = $1 AND company_id = $2', [taskId, actor.companyId]);
  if (!t) throw notFound('Task not found');
  if (t.done_at) throw conflict('Already done');
  if (t.assignee_id !== actor.userId && !hasCapability(actor, 'user.suspend') && !canManage(actor)) throw forbidden('This task is assigned to someone else');
  if (t.kind === 'access' && t.reference_id) {
    // Completing an access task is confirming the removal; the grant record must agree.
    const g = await one<{ status: string }>('SELECT status FROM access_grants WHERE id = $1', [t.reference_id]);
    if (g?.status === 'pending_removal') {
      const grant = await loadGrant(actor, t.reference_id);
      if (!ownsOrManages(actor, grant) && t.assignee_id !== actor.userId) throw forbidden('Only the system owner or an access manager can confirm this');
      await pool.query("UPDATE access_grants SET status = 'removed', removed_at = NOW(3), removed_by = $2 WHERE id = $1", [t.reference_id, actor.userId]);
      await auditFromActor(actor, 'access.grant.removed', { resourceType: 'access_grant', resourceId: t.reference_id, metadata: { offboardingId: t.offboarding_id } });
    }
  }
  if (t.kind === 'asset' && t.reference_id) {
    // The asset itself is returned from Assets, where its history is kept; this confirms collection.
    await auditFromActor(actor, 'offboarding.asset.collected', { resourceType: 'asset', resourceId: t.reference_id, metadata: { offboardingId: t.offboarding_id } });
  }
  await pool.query('UPDATE offboarding_tasks SET done_at = NOW(3), done_by = $2 WHERE id = $1', [taskId, actor.userId]);
  await auditFromActor(actor, 'offboarding.task.done', { resourceType: 'offboarding', resourceId: t.offboarding_id, metadata: { taskId, kind: t.kind } });
}

/* ---------------------------------------------------------------- summary */

export async function myAccessSummary(actor: Actor) {
  if (actor.accessLevel === 'guest' || !hasCapability(actor, 'access.request')) return null;
  const counts = await one<{ to_provision: number; to_remove: number; to_review: number; my_pending: number; expiring: number; offboarding: number }>(
    `SELECT
       (SELECT COUNT(*) FROM access_grants g JOIN access_resources r ON r.id = g.resource_id WHERE g.company_id = $1 AND g.status = 'pending_grant' AND (r.owner_id = $2 OR $3)) AS to_provision,
       (SELECT COUNT(*) FROM access_grants g JOIN access_resources r ON r.id = g.resource_id WHERE g.company_id = $1 AND g.status = 'pending_removal' AND (r.owner_id = $2 OR $3)) AS to_remove,
       (SELECT COUNT(*) FROM access_review_items i JOIN access_reviews v ON v.id = i.review_id WHERE v.company_id = $1 AND v.status = 'open' AND i.reviewer_id = $2 AND i.decision IS NULL) AS to_review,
       (SELECT COUNT(*) FROM access_requests WHERE company_id = $1 AND requester_id = $2 AND status = 'pending') AS my_pending,
       (SELECT COUNT(*) FROM access_grants WHERE user_id = $2 AND status = 'active' AND expires_at IS NOT NULL AND expires_at < DATE_ADD(NOW(3), INTERVAL 7 DAY)) AS expiring,
       (SELECT COUNT(*) FROM offboarding_tasks WHERE company_id = $1 AND assignee_id = $2 AND done_at IS NULL) AS offboarding`,
    [actor.companyId, actor.userId, canManage(actor)]);
  return {
    toProvision: Number(counts?.to_provision ?? 0), toRemove: Number(counts?.to_remove ?? 0), toReview: Number(counts?.to_review ?? 0),
    myPending: Number(counts?.my_pending ?? 0), expiringSoon: Number(counts?.expiring ?? 0), offboardingTasks: Number(counts?.offboarding ?? 0),
  };
}

/* ------------------------------------------------------------------ deletion */

/** A system nobody has requested or held can be deleted; otherwise take it out of the catalogue. */
export async function deleteResource(actor: Actor, id: string) {
  await authorize({ actor, capability: 'access.manage', resourceless: true });
  const r = await loadResource(actor, id);
  const used = await one<{ n: number }>('SELECT (SELECT COUNT(*) FROM access_grants WHERE resource_id = $1) + (SELECT COUNT(*) FROM access_requests WHERE resource_id = $1) AS n', [id]);
  if (Number(used?.n)) throw conflict('This system has access history. Take it out of the catalogue instead so that history stays.');
  await pool.query('DELETE FROM access_resources WHERE id = $1', [id]);
  await auditFromActor(actor, 'access.resource.delete', { resourceType: 'access_resource', resourceId: id, metadata: { name: r.name } });
}

/** An open review nobody has decided anything in can be deleted; a started one is closed when finished. */
export async function deleteReview(actor: Actor, id: string) {
  await authorize({ actor, capability: 'access.manage', resourceless: true });
  const v = await one<{ name: string; status: string; decided: number }>(
    'SELECT v.name, v.status, (SELECT COUNT(*) FROM access_review_items i WHERE i.review_id = v.id AND i.decision IS NOT NULL) AS decided FROM access_reviews v WHERE v.id = $1 AND v.company_id = $2', [id, actor.companyId]);
  if (!v) throw notFound('Review not found');
  if (v.status !== 'open' || Number(v.decided)) throw conflict('Decisions have been recorded in this review, so it stays on record');
  await pool.query('DELETE FROM access_reviews WHERE id = $1', [id]);
  await auditFromActor(actor, 'access.review.delete', { resourceType: 'access_review', resourceId: id, metadata: { name: v.name } });
}

/** Tasks someone added can be removed while open; access and equipment tasks come from real records. */
export async function deleteOffboardingTask(actor: Actor, taskId: string) {
  await authorize({ actor, capability: 'user.suspend', resourceless: true });
  const t = await one<{ kind: string; done_at: Date | null; offboarding_id: string; title: string }>('SELECT kind, done_at, offboarding_id, title FROM offboarding_tasks WHERE id = $1 AND company_id = $2', [taskId, actor.companyId]);
  if (!t) throw notFound('Task not found');
  if (t.kind !== 'custom') throw conflict('Access and equipment tasks are completed, not removed');
  if (t.done_at) throw conflict('This task is already done');
  await pool.query('DELETE FROM offboarding_tasks WHERE id = $1', [taskId]);
  await auditFromActor(actor, 'offboarding.task.delete', { resourceType: 'offboarding', resourceId: t.offboarding_id, metadata: { title: t.title } });
}
