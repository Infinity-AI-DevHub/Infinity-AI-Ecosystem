/**
 * Reliability: the service catalogue and its health, on-call schedules, escalation
 * policies, maintenance windows and the status page.
 *
 * Incidents and alert intake live in incidents.ts and alerts.ts. This module owns the
 * things they read: which services exist, who is on call for them, and what state each is
 * in right now.
 *
 * A service's status is derived, not typed: the worst impact among its open incidents,
 * otherwise 'maintenance' during a window, otherwise 'operational'. Every change is
 * written to service_status_history, which is what availability is computed from.
 */
import { many, newId, one, pool, transaction, type Queryable } from '../core/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { isValidTimezone } from '../core/business-hours.js';
import { onCallAt, upcomingShifts, type Override, type RotationSchedule } from '../core/oncall.js';
import * as searchIndex from './search.js';

export type ServiceStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
const STATUS_RANK: Record<ServiceStatus, number> = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };

const parseJson = <T,>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
};

function requireRead(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
  return authorize({ actor, capability: 'reliability.read', resourceless: true });
}
function requireManage(actor: Actor) {
  return authorize({ actor, capability: 'reliability.manage', resourceless: true });
}

async function assertEmployee(companyId: string, userId: string | null | undefined, field: string) {
  if (userId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND access_level <> 'guest'", [userId, companyId]))) {
    throw unprocessable('Person not found', [{ field, message: 'Choose an employee' }]);
  }
}

/* ---------------------------------------------------------------- services */

type ServiceRow = {
  id: string; company_id: string; name: string; slug: string; description: string | null; tier: string;
  owner_user_id: string | null; support_queue_id: string | null; escalation_policy_id: string | null;
  status: ServiceStatus; status_changed_at: Date; is_public: number; public_name: string | null; is_active: number;
};

const slugify = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'service';

export async function listServices(actor: Actor, opts: { includeInactive?: boolean } = {}) {
  await requireRead(actor);
  const rows = await many<ServiceRow & { owner_name: string | null; queue_name: string | null; policy_name: string | null; open_incidents: number }>(
    `SELECT s.*, u.display_name AS owner_name, q.name AS queue_name, p.name AS policy_name,
            (SELECT COUNT(*) FROM incident_services x JOIN incidents i ON i.id = x.incident_id
              WHERE x.service_id = s.id AND i.status <> 'resolved') AS open_incidents
       FROM services s
       LEFT JOIN users u ON u.id = s.owner_user_id
       LEFT JOIN service_queues q ON q.id = s.support_queue_id
       LEFT JOIN escalation_policies p ON p.id = s.escalation_policy_id
      WHERE s.company_id = $1 ${opts.includeInactive ? '' : 'AND s.is_active = 1'}
      ORDER BY FIELD(s.tier, 'critical','high','standard'), s.name`,
    [actor.companyId],
  );
  const since = new Date(Date.now() - 30 * 86_400_000);
  const uptime = await availability(actor.companyId, rows.map((r) => r.id), since, new Date());
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug, description: r.description, tier: r.tier,
    ownerUserId: r.owner_user_id, ownerName: r.owner_name, supportQueueId: r.support_queue_id, supportQueueName: r.queue_name,
    escalationPolicyId: r.escalation_policy_id, escalationPolicyName: r.policy_name,
    status: r.status, statusChangedAt: r.status_changed_at, isPublic: Boolean(r.is_public), publicName: r.public_name,
    isActive: Boolean(r.is_active), openIncidents: Number(r.open_incidents), availability30d: uptime.get(r.id) ?? null,
  }));
}

type ServiceInput = {
  name: string; description?: string | null; tier?: 'critical' | 'high' | 'standard'; ownerUserId?: string | null;
  supportQueueId?: string | null; escalationPolicyId?: string | null; isPublic?: boolean; publicName?: string | null; isActive?: boolean;
};

async function assertServiceRefs(companyId: string, input: Partial<ServiceInput>) {
  await assertEmployee(companyId, input.ownerUserId, 'ownerUserId');
  if (input.supportQueueId && !(await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2', [input.supportQueueId, companyId]))) {
    throw unprocessable('Queue not found', [{ field: 'supportQueueId', message: 'Choose a queue' }]);
  }
  if (input.escalationPolicyId && !(await one('SELECT 1 FROM escalation_policies WHERE id = $1 AND company_id = $2', [input.escalationPolicyId, companyId]))) {
    throw unprocessable('Escalation policy not found', [{ field: 'escalationPolicyId', message: 'Choose a policy' }]);
  }
}

export async function saveService(actor: Actor, id: string | null, input: ServiceInput) {
  // Engineering managers add services to the catalogue; changing how an existing service is
  // paged or supported stays with reliability managers.
  if (id || !hasCapability(actor, 'engineering.manage')) await requireManage(actor);
  await assertServiceRefs(actor.companyId, input);
  const name = input.name.trim();
  if (await one('SELECT 1 FROM services WHERE company_id = $1 AND name = $2 AND id <> $3', [actor.companyId, name, id ?? ''])) {
    throw conflict('A service with that name already exists');
  }
  const serviceId = id ?? newId();
  if (id) {
    const res = await pool.query(
      `UPDATE services SET name = $3, description = $4, tier = $5, owner_user_id = $6, support_queue_id = $7,
         escalation_policy_id = $8, is_public = $9, public_name = $10, is_active = $11
       WHERE id = $1 AND company_id = $2`,
      [id, actor.companyId, name, input.description?.trim() || null, input.tier ?? 'standard', input.ownerUserId ?? null,
        input.supportQueueId ?? null, input.escalationPolicyId ?? null, Boolean(input.isPublic), input.publicName?.trim() || null, input.isActive ?? true],
    );
    if (res.rowCount === 0) throw notFound('Service not found');
  } else {
    let slug = slugify(name);
    if (await one('SELECT 1 FROM services WHERE company_id = $1 AND slug = $2', [actor.companyId, slug])) slug = `${slug}-${serviceId.slice(0, 6)}`;
    await pool.query(
      `INSERT INTO services (id, company_id, name, slug, description, tier, owner_user_id, support_queue_id, escalation_policy_id, is_public, public_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [serviceId, actor.companyId, name, slug, input.description?.trim() || null, input.tier ?? 'standard', input.ownerUserId ?? null,
        input.supportQueueId ?? null, input.escalationPolicyId ?? null, Boolean(input.isPublic), input.publicName?.trim() || null, actor.userId],
    );
    await pool.query("INSERT INTO service_status_history (service_id, company_id, status, started_at) VALUES ($1,$2,'operational',NOW(3))", [serviceId, actor.companyId]);
  }
  await auditFromActor(actor, id ? 'reliability.service.update' : 'reliability.service.create', { resourceType: 'service', resourceId: serviceId, metadata: { name } });
  await searchIndex.index({
    companyId: actor.companyId, docType: 'service', resourceId: serviceId, title: name,
    body: `${name} ${input.description ?? ''}`, aclCompanyWide: true, link: `/engineering/services/${serviceId}`,
  });
  return { id: serviceId };
}

/**
 * Recomputes a service's status from its open incidents and maintenance windows, and
 * records the transition. Safe to call repeatedly; it only writes when something changed.
 */
export async function recomputeServiceStatus(serviceId: string, db: Queryable = pool): Promise<ServiceStatus | null> {
  const svc = (await db.query<ServiceRow>('SELECT * FROM services WHERE id = $1', [serviceId])).rows[0];
  if (!svc) return null;
  const impacts = (await db.query<{ impact: ServiceStatus; incident_id: string }>(
    `SELECT x.impact, x.incident_id FROM incident_services x JOIN incidents i ON i.id = x.incident_id
      WHERE x.service_id = $1 AND i.status <> 'resolved'`, [serviceId])).rows;
  const inMaintenance = (await db.query(
    `SELECT 1 FROM maintenance_services ms JOIN maintenance_windows w ON w.id = ms.window_id
      WHERE ms.service_id = $1 AND w.status = 'scheduled' AND w.starts_at <= NOW(3) AND w.ends_at > NOW(3) LIMIT 1`, [serviceId])).rows.length > 0;
  let next: ServiceStatus = inMaintenance ? 'maintenance' : 'operational';
  let incidentId: string | null = null;
  for (const i of impacts) {
    if (STATUS_RANK[i.impact] > STATUS_RANK[next]) { next = i.impact; incidentId = i.incident_id; }
  }
  if (next === svc.status) return next;
  await db.query('UPDATE services SET status = $2, status_changed_at = NOW(3) WHERE id = $1', [serviceId, next]);
  await db.query('UPDATE service_status_history SET ended_at = NOW(3) WHERE service_id = $1 AND ended_at IS NULL', [serviceId]);
  await db.query('INSERT INTO service_status_history (service_id, company_id, status, started_at, incident_id) VALUES ($1,$2,$3,NOW(3),$4)',
    [serviceId, svc.company_id, next, incidentId]);
  return next;
}

/**
 * Availability over a period: the share of time not spent in partial or major outage.
 * Degraded and maintenance count as available - they are reported, not hidden, but a
 * planned window is not an outage and a slow service is still serving.
 */
export async function availability(companyId: string, serviceIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (serviceIds.length === 0) return out;
  const rows = await many<{ service_id: string; status: string; started_at: Date; ended_at: Date | null }>(
    `SELECT service_id, status, started_at, ended_at FROM service_status_history
      WHERE company_id = $1 AND service_id IN (${serviceIds.map((_, i) => `$${i + 4}`).join(',')})
        AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2)`,
    [companyId, from, to, ...serviceIds],
  );
  const span = to.getTime() - from.getTime();
  for (const id of serviceIds) out.set(id, 100);
  const down = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'partial_outage' && r.status !== 'major_outage') continue;
    const s = Math.max(new Date(r.started_at).getTime(), from.getTime());
    const e = Math.min(r.ended_at ? new Date(r.ended_at).getTime() : to.getTime(), to.getTime());
    if (e > s) down.set(r.service_id, (down.get(r.service_id) ?? 0) + (e - s));
  }
  for (const [id, ms] of down) out.set(id, Math.max(0, Math.round((1 - ms / span) * 100_000) / 1000));
  return out;
}

export async function getService(actor: Actor, id: string) {
  await requireRead(actor);
  const list = await listServices(actor, { includeInactive: true });
  const svc = list.find((s) => s.id === id);
  if (!svc) throw notFound('Service not found');
  const history = await many<{ status: string; started_at: Date; ended_at: Date | null; incident_id: string | null }>(
    `SELECT status, started_at, ended_at, incident_id FROM service_status_history
      WHERE service_id = $1 AND company_id = $2 ORDER BY started_at DESC LIMIT 50`, [id, actor.companyId]);
  const incidents = await many<{ id: string; number: number; title: string; severity: string; status: string; detected_at: Date; resolved_at: Date | null }>(
    `SELECT i.id, i.number, i.title, i.severity, i.status, i.detected_at, i.resolved_at FROM incident_services x JOIN incidents i ON i.id = x.incident_id
      WHERE x.service_id = $1 AND i.company_id = $2 ORDER BY i.detected_at DESC LIMIT 20`, [id, actor.companyId]);
  const integrations = hasCapability(actor, 'reliability.manage') ? await many<{ id: string; name: string; kind: string; is_active: number; last_received_at: Date | null; heartbeat_minutes: number | null; heartbeat_missed_at: Date | null; secret_fingerprint: string; endpoint_key: string; incident_severity: string | null }>(
    `SELECT id, name, kind, is_active, last_received_at, heartbeat_minutes, heartbeat_missed_at, secret_fingerprint, endpoint_key, incident_severity
       FROM alert_integrations WHERE service_id = $1 AND company_id = $2 ORDER BY created_at`, [id, actor.companyId]) : [];
  const now = new Date();
  const uptime90 = (await availability(actor.companyId, [id], new Date(now.getTime() - 90 * 86_400_000), now)).get(id) ?? 100;
  const { config } = await import('../core/config.js');
  return {
    ...svc,
    availability90d: uptime90,
    onCall: svc.escalationPolicyId ? await currentResponders(actor.companyId, svc.escalationPolicyId) : [],
    history: history.map((h) => ({ status: h.status, startedAt: h.started_at, endedAt: h.ended_at, incidentId: h.incident_id })),
    incidents: incidents.map((i) => ({ id: i.id, ref: `INC-${i.number}`, title: i.title, severity: i.severity, status: i.status, detectedAt: i.detected_at, resolvedAt: i.resolved_at })),
    integrations: integrations.map((x) => ({
      id: x.id, name: x.name, kind: x.kind, isActive: Boolean(x.is_active), lastReceivedAt: x.last_received_at,
      heartbeatMinutes: x.heartbeat_minutes, heartbeatMissedAt: x.heartbeat_missed_at, secretFingerprint: x.secret_fingerprint,
      incidentSeverity: x.incident_severity,
      endpoint: x.kind === 'heartbeat'
        ? `${config.apiUrl}/api/v1/reliability/heartbeat/${x.endpoint_key}`
        : `${config.apiUrl}/api/v1/reliability/alerts/${x.endpoint_key}`,
    })),
  };
}

/* ------------------------------------------------------------------ on-call */

type ScheduleRow = { id: string; company_id: string; name: string; timezone: string; rotation: 'daily' | 'weekly'; handoff_minute: number; rotation_start: Date | string; members: unknown };

const toDay = (v: Date | string) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10));

function asRotation(r: ScheduleRow): RotationSchedule {
  return { timezone: r.timezone, rotation: r.rotation, handoffMinute: Number(r.handoff_minute), rotationStart: toDay(r.rotation_start), members: parseJson<string[]>(r.members, []) };
}

async function overridesFor(scheduleId: string, from: Date): Promise<Override[]> {
  const rows = await many<{ user_id: string; starts_at: Date; ends_at: Date; created_at: Date }>(
    'SELECT user_id, starts_at, ends_at, created_at FROM oncall_overrides WHERE schedule_id = $1 AND ends_at > $2', [scheduleId, from]);
  return rows.map((o) => ({ userId: o.user_id, startsAt: new Date(o.starts_at), endsAt: new Date(o.ends_at), createdAt: new Date(o.created_at) }));
}

export async function whoIsOnCall(scheduleId: string, at = new Date()): Promise<string | null> {
  const row = await one<ScheduleRow>('SELECT * FROM oncall_schedules WHERE id = $1', [scheduleId]);
  if (!row) return null;
  return onCallAt(asRotation(row), await overridesFor(scheduleId, new Date(at.getTime() - 1)), at)?.userId ?? null;
}

export async function listSchedules(actor: Actor) {
  await requireRead(actor);
  const rows = await many<ScheduleRow>('SELECT * FROM oncall_schedules WHERE company_id = $1 ORDER BY name', [actor.companyId]);
  const users = await many<{ id: string; display_name: string; status: string }>("SELECT id, display_name, status FROM users WHERE company_id = $1 AND access_level <> 'guest'", [actor.companyId]);
  const name = (id: string) => users.find((u) => u.id === id)?.display_name ?? 'Former member';
  const now = new Date();
  const out = [];
  for (const r of rows) {
    const rotation = asRotation(r);
    const overrides = await overridesFor(r.id, now);
    const current = onCallAt(rotation, overrides, now);
    const overrideRows = await many<{ id: string; user_id: string; starts_at: Date; ends_at: Date; reason: string | null }>(
      'SELECT id, user_id, starts_at, ends_at, reason FROM oncall_overrides WHERE schedule_id = $1 AND ends_at > NOW(3) ORDER BY starts_at', [r.id]);
    out.push({
      id: r.id, name: r.name, timezone: r.timezone, rotation: r.rotation, handoffMinute: Number(r.handoff_minute), rotationStart: rotation.rotationStart,
      members: rotation.members.map((id) => ({ id, name: name(id) })),
      current: current ? { userId: current.userId, name: name(current.userId), until: current.endsAt, override: current.override } : null,
      upcoming: upcomingShifts(rotation, overrides, now, 6).map((s) => ({ userId: s.userId, name: name(s.userId), startsAt: s.startsAt, endsAt: s.endsAt, override: s.override })),
      overrides: overrideRows.map((o) => ({ id: o.id, userId: o.user_id, name: name(o.user_id), startsAt: o.starts_at, endsAt: o.ends_at, reason: o.reason })),
    });
  }
  return out;
}

type ScheduleInput = { name: string; timezone: string; rotation: 'daily' | 'weekly'; handoffMinute: number; rotationStart: string; members: string[] };

export async function saveSchedule(actor: Actor, id: string | null, input: ScheduleInput) {
  await requireManage(actor);
  if (!isValidTimezone(input.timezone)) throw unprocessable('Unknown timezone', [{ field: 'timezone', message: 'Use a name like Asia/Colombo' }]);
  const members = [...new Set(input.members)];
  if (members.length === 0) throw unprocessable('Add at least one person to the rotation', [{ field: 'members', message: 'Required' }]);
  for (const m of members) await assertEmployee(actor.companyId, m, 'members');
  if (await one('SELECT 1 FROM oncall_schedules WHERE company_id = $1 AND name = $2 AND id <> $3', [actor.companyId, input.name.trim(), id ?? ''])) {
    throw conflict('A schedule with that name already exists');
  }
  const scheduleId = id ?? newId();
  if (id) {
    const res = await pool.query(
      'UPDATE oncall_schedules SET name = $3, timezone = $4, rotation = $5, handoff_minute = $6, rotation_start = $7, members = $8 WHERE id = $1 AND company_id = $2',
      [id, actor.companyId, input.name.trim(), input.timezone, input.rotation, input.handoffMinute, input.rotationStart, JSON.stringify(members)]);
    if (res.rowCount === 0) throw notFound('Schedule not found');
  } else {
    await pool.query(
      'INSERT INTO oncall_schedules (id, company_id, name, timezone, rotation, handoff_minute, rotation_start, members, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [scheduleId, actor.companyId, input.name.trim(), input.timezone, input.rotation, input.handoffMinute, input.rotationStart, JSON.stringify(members), actor.userId]);
  }
  await auditFromActor(actor, id ? 'oncall.schedule.update' : 'oncall.schedule.create', { resourceType: 'oncall_schedule', resourceId: scheduleId, metadata: { members: members.length } });
  return { id: scheduleId };
}

export async function addOverride(actor: Actor, scheduleId: string, input: { userId: string; startsAt: string; endsAt: string; reason?: string | null }) {
  await requireRead(actor);
  const schedule = await one<ScheduleRow>('SELECT * FROM oncall_schedules WHERE id = $1 AND company_id = $2', [scheduleId, actor.companyId]);
  if (!schedule) throw notFound('Schedule not found');
  // Anyone on the rotation may cover a shift (swap with a colleague); otherwise it is a manager's call.
  const members = parseJson<string[]>(schedule.members, []);
  if (!hasCapability(actor, 'reliability.manage') && !(members.includes(actor.userId) && input.userId === actor.userId)) {
    throw forbidden('You can cover shifts on rotations you belong to; ask a reliability manager for anything else');
  }
  await assertEmployee(actor.companyId, input.userId, 'userId');
  const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt);
  if (!(endsAt > startsAt)) throw unprocessable('The override must end after it starts', [{ field: 'endsAt', message: 'End after the start' }]);
  if (endsAt < new Date()) throw unprocessable('That period is already over', [{ field: 'endsAt', message: 'Choose a future time' }]);
  const id = newId();
  await pool.query('INSERT INTO oncall_overrides (id, schedule_id, company_id, user_id, starts_at, ends_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, scheduleId, actor.companyId, input.userId, startsAt, endsAt, input.reason?.trim() || null, actor.userId]);
  await auditFromActor(actor, 'oncall.override.create', { resourceType: 'oncall_schedule', resourceId: scheduleId, metadata: { userId: input.userId } });
  return { id };
}

export async function removeOverride(actor: Actor, overrideId: string) {
  const o = await one<{ schedule_id: string; created_by: string | null }>('SELECT schedule_id, created_by FROM oncall_overrides WHERE id = $1 AND company_id = $2', [overrideId, actor.companyId]);
  if (!o) throw notFound('Override not found');
  if (!hasCapability(actor, 'reliability.manage') && o.created_by !== actor.userId) throw forbidden('Only the person who added it or a reliability manager can remove it');
  await pool.query('DELETE FROM oncall_overrides WHERE id = $1', [overrideId]);
  await auditFromActor(actor, 'oncall.override.delete', { resourceType: 'oncall_schedule', resourceId: o.schedule_id });
}

/* -------------------------------------------------------------- escalation */

export type EscalationTarget = { type: 'schedule' | 'user'; id: string };
export type EscalationLevel = { delayMinutes: number; targets: EscalationTarget[] };

export async function listPolicies(actor: Actor) {
  await requireRead(actor);
  const rows = await many<{ id: string; name: string; levels: unknown; repeat_count: number }>('SELECT id, name, levels, repeat_count FROM escalation_policies WHERE company_id = $1 ORDER BY name', [actor.companyId]);
  const schedules = await many<{ id: string; name: string }>('SELECT id, name FROM oncall_schedules WHERE company_id = $1', [actor.companyId]);
  const users = await many<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE company_id = $1', [actor.companyId]);
  return rows.map((r) => ({
    id: r.id, name: r.name, repeatCount: Number(r.repeat_count),
    levels: parseJson<EscalationLevel[]>(r.levels, []).map((l) => ({
      delayMinutes: l.delayMinutes,
      targets: l.targets.map((t) => ({ ...t, name: t.type === 'schedule' ? schedules.find((s) => s.id === t.id)?.name ?? 'Deleted schedule' : users.find((u) => u.id === t.id)?.display_name ?? 'Former member' })),
    })),
  }));
}

export async function savePolicy(actor: Actor, id: string | null, input: { name: string; repeatCount: number; levels: EscalationLevel[] }) {
  await requireManage(actor);
  if (input.levels.length === 0 || input.levels.length > 6) throw unprocessable('A policy needs between one and six levels');
  for (const [i, level] of input.levels.entries()) {
    if (level.targets.length === 0) throw unprocessable(`Level ${i + 1} has nobody to page`, [{ field: `levels.${i}`, message: 'Add a schedule or person' }]);
    if (i > 0 && level.delayMinutes < 1) throw unprocessable(`Level ${i + 1} needs a delay of at least a minute`, [{ field: `levels.${i}.delayMinutes`, message: 'At least 1' }]);
    for (const t of level.targets) {
      const ok = t.type === 'schedule'
        ? await one('SELECT 1 FROM oncall_schedules WHERE id = $1 AND company_id = $2', [t.id, actor.companyId])
        : await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND access_level <> 'guest'", [t.id, actor.companyId]);
      if (!ok) throw unprocessable(`Level ${i + 1} names a ${t.type} that does not exist`, [{ field: `levels.${i}.targets`, message: 'Choose again' }]);
    }
  }
  if (await one('SELECT 1 FROM escalation_policies WHERE company_id = $1 AND name = $2 AND id <> $3', [actor.companyId, input.name.trim(), id ?? ''])) {
    throw conflict('A policy with that name already exists');
  }
  const policyId = id ?? newId();
  const levels = JSON.stringify(input.levels.map((l, i) => ({ delayMinutes: i === 0 ? 0 : l.delayMinutes, targets: l.targets })));
  if (id) {
    const res = await pool.query('UPDATE escalation_policies SET name = $3, levels = $4, repeat_count = $5 WHERE id = $1 AND company_id = $2', [id, actor.companyId, input.name.trim(), levels, input.repeatCount]);
    if (res.rowCount === 0) throw notFound('Policy not found');
  } else {
    await pool.query('INSERT INTO escalation_policies (id, company_id, name, levels, repeat_count, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [policyId, actor.companyId, input.name.trim(), levels, input.repeatCount, actor.userId]);
  }
  await auditFromActor(actor, id ? 'escalation.policy.update' : 'escalation.policy.create', { resourceType: 'escalation_policy', resourceId: policyId, metadata: { levels: input.levels.length } });
  return { id: policyId };
}

/** The people a policy level pages right now: schedule targets resolved to whoever is on call. */
export async function resolveLevel(companyId: string, policyId: string, levelIndex: number): Promise<{ userIds: string[]; levelCount: number; delayMinutes: number | null; repeatCount: number }> {
  const row = await one<{ levels: unknown; repeat_count: number }>('SELECT levels, repeat_count FROM escalation_policies WHERE id = $1 AND company_id = $2', [policyId, companyId]);
  const levels = parseJson<EscalationLevel[]>(row?.levels, []);
  const level = levels[levelIndex];
  if (!level) return { userIds: [], levelCount: levels.length, delayMinutes: null, repeatCount: Number(row?.repeat_count ?? 0) };
  const ids = new Set<string>();
  for (const t of level.targets) {
    const userId = t.type === 'schedule' ? await whoIsOnCall(t.id) : t.id;
    if (userId && (await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'", [userId, companyId]))) ids.add(userId);
  }
  return { userIds: [...ids], levelCount: levels.length, delayMinutes: levels[levelIndex + 1]?.delayMinutes ?? null, repeatCount: Number(row?.repeat_count ?? 0) };
}

async function currentResponders(companyId: string, policyId: string) {
  const { userIds } = await resolveLevel(companyId, policyId, 0);
  if (userIds.length === 0) return [];
  return many<{ id: string; display_name: string }>(`SELECT id, display_name FROM users WHERE id IN (${userIds.map((_, i) => `$${i + 1}`).join(',')})`, userIds);
}

/* -------------------------------------------------------------- maintenance */

export async function listMaintenance(actor: Actor, scope: 'upcoming' | 'past') {
  await requireRead(actor);
  const rows = await many<{ id: string; title: string; description: string | null; starts_at: Date; ends_at: Date; is_public: number; suppress_alerts: number; status: string; change_id: string | null; change_number: number | null }>(
    `SELECT w.*, c.number AS change_number FROM maintenance_windows w LEFT JOIN change_requests c ON c.id = w.change_id
      WHERE w.company_id = $1 AND ${scope === 'upcoming' ? 'w.ends_at >= NOW(3)' : 'w.ends_at < NOW(3)'}
      ORDER BY w.starts_at ${scope === 'upcoming' ? 'ASC' : 'DESC'} LIMIT 100`, [actor.companyId]);
  const links = rows.length ? await many<{ window_id: string; service_id: string; name: string }>(
    `SELECT ms.window_id, s.id AS service_id, s.name FROM maintenance_services ms JOIN services s ON s.id = ms.service_id
      WHERE ms.window_id IN (${rows.map((_, i) => `$${i + 1}`).join(',')})`, rows.map((r) => r.id)) : [];
  const now = Date.now();
  return rows.map((w) => ({
    id: w.id, title: w.title, description: w.description, startsAt: w.starts_at, endsAt: w.ends_at,
    isPublic: Boolean(w.is_public), suppressAlerts: Boolean(w.suppress_alerts), status: w.status,
    phase: w.status === 'cancelled' ? 'cancelled' : new Date(w.starts_at).getTime() > now ? 'upcoming' : new Date(w.ends_at).getTime() > now ? 'in_progress' : 'completed',
    change: w.change_id ? { id: w.change_id, ref: `CHG-${w.change_number}` } : null,
    services: links.filter((l) => l.window_id === w.id).map((l) => ({ id: l.service_id, name: l.name })),
  }));
}

export async function saveMaintenance(actor: Actor, id: string | null, input: { title: string; description?: string | null; startsAt: string; endsAt: string; isPublic?: boolean; suppressAlerts?: boolean; serviceIds: string[]; changeId?: string | null; cancelled?: boolean }) {
  await requireManage(actor);
  const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt);
  if (!(endsAt > startsAt)) throw unprocessable('The window must end after it starts', [{ field: 'endsAt', message: 'End after the start' }]);
  if (input.serviceIds.length === 0) throw unprocessable('Choose the services affected', [{ field: 'serviceIds', message: 'Required' }]);
  for (const s of input.serviceIds) {
    if (!(await one('SELECT 1 FROM services WHERE id = $1 AND company_id = $2', [s, actor.companyId]))) throw unprocessable('Service not found', [{ field: 'serviceIds', message: 'Choose again' }]);
  }
  if (input.changeId && !(await one('SELECT 1 FROM change_requests WHERE id = $1 AND company_id = $2', [input.changeId, actor.companyId]))) {
    throw unprocessable('Change not found', [{ field: 'changeId', message: 'Choose a change' }]);
  }
  const windowId = id ?? newId();
  const previous = id ? await many<{ service_id: string }>('SELECT service_id FROM maintenance_services WHERE window_id = $1', [id]) : [];
  await transaction(async (tx) => {
    if (id) {
      const res = await tx.query(
        `UPDATE maintenance_windows SET title = $3, description = $4, starts_at = $5, ends_at = $6, is_public = $7, suppress_alerts = $8, change_id = $9, status = $10
          WHERE id = $1 AND company_id = $2`,
        [id, actor.companyId, input.title.trim(), input.description?.trim() || null, startsAt, endsAt, input.isPublic ?? true, input.suppressAlerts ?? true, input.changeId ?? null, input.cancelled ? 'cancelled' : 'scheduled']);
      if (res.rowCount === 0) throw notFound('Maintenance window not found');
      await tx.query('DELETE FROM maintenance_services WHERE window_id = $1', [id]);
    } else {
      await tx.query(
        `INSERT INTO maintenance_windows (id, company_id, title, description, starts_at, ends_at, is_public, suppress_alerts, change_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [windowId, actor.companyId, input.title.trim(), input.description?.trim() || null, startsAt, endsAt, input.isPublic ?? true, input.suppressAlerts ?? true, input.changeId ?? null, actor.userId]);
    }
    for (const s of new Set(input.serviceIds)) await tx.query('INSERT INTO maintenance_services (window_id, service_id) VALUES ($1,$2)', [windowId, s]);
    await auditFromActor(actor, id ? (input.cancelled ? 'maintenance.cancel' : 'maintenance.update') : 'maintenance.create', { resourceType: 'maintenance_window', resourceId: windowId, metadata: { services: input.serviceIds.length } }, tx);
  });
  for (const s of new Set([...input.serviceIds, ...previous.map((p) => p.service_id)])) await recomputeServiceStatus(s);
  return { id: windowId };
}

/** Scheduled: moves services into and out of maintenance as windows open and close. */
export async function syncMaintenanceStatuses(): Promise<void> {
  const rows = await many<{ service_id: string }>(
    `SELECT DISTINCT ms.service_id FROM maintenance_services ms JOIN maintenance_windows w ON w.id = ms.window_id
      WHERE (w.starts_at BETWEEN DATE_SUB(NOW(3), INTERVAL 5 MINUTE) AND NOW(3))
         OR (w.ends_at BETWEEN DATE_SUB(NOW(3), INTERVAL 5 MINUTE) AND NOW(3))
         OR (w.status = 'cancelled' AND w.updated_at > DATE_SUB(NOW(3), INTERVAL 5 MINUTE))`);
  const stale = await many<{ id: string }>(
    `SELECT s.id FROM services s WHERE s.status = 'maintenance' AND NOT EXISTS (
       SELECT 1 FROM maintenance_services ms JOIN maintenance_windows w ON w.id = ms.window_id
        WHERE ms.service_id = s.id AND w.status = 'scheduled' AND w.starts_at <= NOW(3) AND w.ends_at > NOW(3))`);
  for (const id of new Set([...rows.map((r) => r.service_id), ...stale.map((s) => s.id)])) await recomputeServiceStatus(id);
}

export async function inMaintenance(serviceId: string): Promise<boolean> {
  return Boolean(await one(
    `SELECT 1 FROM maintenance_services ms JOIN maintenance_windows w ON w.id = ms.window_id
      WHERE ms.service_id = $1 AND w.status = 'scheduled' AND w.suppress_alerts = 1 AND w.starts_at <= NOW(3) AND w.ends_at > NOW(3)`, [serviceId]));
}

/* -------------------------------------------------------------- status page */

export async function getStatusPageSettings(actor: Actor) {
  await requireRead(actor);
  const row = await one<{ slug: string; title: string; intro: string | null; is_enabled: number }>('SELECT slug, title, intro, is_enabled FROM status_pages WHERE company_id = $1', [actor.companyId]);
  const { config } = await import('../core/config.js');
  return row
    ? { configured: true, slug: row.slug, title: row.title, intro: row.intro, isEnabled: Boolean(row.is_enabled), url: `${config.publicUrl}/status/${row.slug}` }
    : { configured: false, slug: null, title: null, intro: null, isEnabled: false, url: null };
}

export async function saveStatusPage(actor: Actor, input: { slug: string; title: string; intro?: string | null; isEnabled: boolean }) {
  await requireManage(actor);
  const slug = slugify(input.slug);
  if (slug.length < 3) throw unprocessable('Use at least three letters or numbers', [{ field: 'slug', message: 'Too short' }]);
  const taken = await one<{ company_id: string }>('SELECT company_id FROM status_pages WHERE slug = $1', [slug]);
  if (taken && taken.company_id !== actor.companyId) throw conflict('That address is taken');
  await pool.query(
    `INSERT INTO status_pages (company_id, slug, title, intro, is_enabled, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON DUPLICATE KEY UPDATE slug = VALUES(slug), title = VALUES(title), intro = VALUES(intro), is_enabled = VALUES(is_enabled), updated_by = VALUES(updated_by)`,
    [actor.companyId, slug, input.title.trim(), input.intro?.trim() || null, input.isEnabled, actor.userId]);
  await auditFromActor(actor, 'statuspage.update', { resourceType: 'status_page', metadata: { slug, enabled: input.isEnabled } });
  return getStatusPageSettings(actor);
}

type StatusView = {
  title: string; intro: string | null; overall: ServiceStatus;
  services: { id: string; name: string; status: ServiceStatus; availability90d: number }[];
  incidents: { id: string; ref: string; title: string; severity: string | null; status: string; startedAt: Date; resolvedAt: Date | null; updates: { body: string; status: string | null; createdAt: Date }[] }[];
  maintenance: { id: string; title: string; description: string | null; startsAt: Date; endsAt: Date; services: string[] }[];
};

async function buildStatus(companyId: string, publicView: boolean, title: string, intro: string | null): Promise<StatusView> {
  const services = await many<{ id: string; name: string; public_name: string | null; status: ServiceStatus }>(
    `SELECT id, name, public_name, status FROM services WHERE company_id = $1 AND is_active = 1 ${publicView ? 'AND is_public = 1' : ''}
      ORDER BY FIELD(tier, 'critical','high','standard'), name`, [companyId]);
  const ids = services.map((s) => s.id);
  const now = new Date();
  const uptime = await availability(companyId, ids, new Date(now.getTime() - 90 * 86_400_000), now);
  const incidents = ids.length ? await many<{ id: string; number: number; title: string; public_title: string | null; severity: string; status: string; detected_at: Date; resolved_at: Date | null }>(
    `SELECT DISTINCT i.id, i.number, i.title, i.public_title, i.severity, i.status, i.detected_at, i.resolved_at
       FROM incidents i JOIN incident_services x ON x.incident_id = i.id
      WHERE i.company_id = $1 AND x.service_id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})
        ${publicView ? 'AND i.is_public = 1' : ''}
        AND (i.status <> 'resolved' OR i.resolved_at > DATE_SUB(NOW(3), INTERVAL 7 DAY))
      ORDER BY i.detected_at DESC LIMIT 20`, [companyId, ...ids]) : [];
  const updates = incidents.length ? await many<{ incident_id: string; body: string; status: string | null; created_at: Date }>(
    `SELECT incident_id, body, status, created_at FROM incident_events
      WHERE incident_id IN (${incidents.map((_, i) => `$${i + 1}`).join(',')}) AND visibility = 'public' AND body IS NOT NULL
      ORDER BY id DESC`, incidents.map((i) => i.id)) : [];
  const windows = ids.length ? await many<{ id: string; title: string; description: string | null; starts_at: Date; ends_at: Date; service_names: string }>(
    `SELECT w.id, w.title, w.description, w.starts_at, w.ends_at, GROUP_CONCAT(COALESCE(s.public_name, s.name) SEPARATOR '||') AS service_names
       FROM maintenance_windows w JOIN maintenance_services ms ON ms.window_id = w.id JOIN services s ON s.id = ms.service_id
      WHERE w.company_id = $1 AND w.status = 'scheduled' AND w.ends_at >= NOW(3) AND w.starts_at <= DATE_ADD(NOW(3), INTERVAL 14 DAY)
        ${publicView ? 'AND w.is_public = 1 AND s.is_public = 1' : ''}
      GROUP BY w.id, w.title, w.description, w.starts_at, w.ends_at ORDER BY w.starts_at`, [companyId]) : [];
  const overall = services.reduce<ServiceStatus>((worst, s) => (STATUS_RANK[s.status] > STATUS_RANK[worst] ? s.status : worst), 'operational');
  return {
    title, intro, overall,
    services: services.map((s) => ({ id: s.id, name: publicView ? s.public_name || s.name : s.name, status: s.status, availability90d: uptime.get(s.id) ?? 100 })),
    incidents: incidents.map((i) => ({
      id: i.id, ref: `INC-${i.number}`, title: publicView ? i.public_title || i.title : i.title, severity: publicView ? null : i.severity,
      status: i.status, startedAt: i.detected_at, resolvedAt: i.resolved_at,
      updates: updates.filter((u) => u.incident_id === i.id).map((u) => ({ body: u.body, status: u.status, createdAt: u.created_at })),
    })),
    maintenance: windows.map((w) => ({ id: w.id, title: w.title, description: w.description, startsAt: w.starts_at, endsAt: w.ends_at, services: w.service_names.split('||') })),
  };
}

export async function internalStatus(actor: Actor) {
  await requireRead(actor);
  return buildStatus(actor.companyId, false, 'Service status', null);
}

/** Served without a session. Only what a manager has explicitly marked public, and only while the page is on. */
export async function publicStatus(slug: string) {
  const page = await one<{ company_id: string; title: string; intro: string | null; is_enabled: number }>('SELECT company_id, title, intro, is_enabled FROM status_pages WHERE slug = $1', [slug]);
  if (!page || !page.is_enabled) throw notFound('Status page not found');
  const view = await buildStatus(page.company_id, true, page.title, page.intro);
  // Internal ids are not needed by the public page.
  return { ...view, services: view.services.map(({ id: _id, ...s }) => s), incidents: view.incidents.map(({ id: _id, ...i }) => i), maintenance: view.maintenance.map(({ id: _id, ...m }) => m) };
}

/* ----------------------------------------------------------------- reports */

export async function report(actor: Actor, days: number) {
  await requireRead(actor);
  const from = new Date(Date.now() - days * 86_400_000);
  const incidents = await many<{ id: string; severity: string; detected_at: Date; acknowledged_at: Date | null; resolved_at: Date | null; source: string }>(
    'SELECT id, severity, detected_at, acknowledged_at, resolved_at, source FROM incidents WHERE company_id = $1 AND detected_at >= $2', [actor.companyId, from]);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const minutes = (a: Date, b: Date) => (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
  const services = await many<{ id: string; name: string; tier: string }>('SELECT id, name, tier FROM services WHERE company_id = $1 AND is_active = 1 ORDER BY name', [actor.companyId]);
  const uptime = await availability(actor.companyId, services.map((s) => s.id), from, new Date());
  const byService = await many<{ service_id: string; n: number }>(
    `SELECT x.service_id, COUNT(*) AS n FROM incident_services x JOIN incidents i ON i.id = x.incident_id
      WHERE i.company_id = $1 AND i.detected_at >= $2 GROUP BY x.service_id`, [actor.companyId, from]);
  const alerts = await one<{ total: number; suppressed: number; with_incident: number }>(
    `SELECT COUNT(*) AS total, SUM(suppressed) AS suppressed, SUM(incident_id IS NOT NULL) AS with_incident FROM alerts WHERE company_id = $1 AND first_seen_at >= $2`, [actor.companyId, from]);
  const postmortems = await one<{ due: number; published: number }>(
    `SELECT SUM(i.severity IN ('sev1','sev2') AND i.status = 'resolved') AS due,
            SUM(i.severity IN ('sev1','sev2') AND p.status = 'published') AS published
       FROM incidents i LEFT JOIN postmortems p ON p.incident_id = i.id WHERE i.company_id = $1 AND i.detected_at >= $2`, [actor.companyId, from]);
  return {
    days,
    incidents: incidents.length,
    bySeverity: ['sev1', 'sev2', 'sev3', 'sev4'].map((s) => ({ severity: s, count: incidents.filter((i) => i.severity === s).length })),
    fromAlerts: incidents.filter((i) => i.source !== 'manual').length,
    meanTimeToAcknowledgeMinutes: avg(incidents.filter((i) => i.acknowledged_at).map((i) => minutes(i.detected_at, i.acknowledged_at!))),
    meanTimeToResolveMinutes: avg(incidents.filter((i) => i.resolved_at).map((i) => minutes(i.detected_at, i.resolved_at!))),
    alerts: { total: Number(alerts?.total ?? 0), suppressed: Number(alerts?.suppressed ?? 0), openedIncidents: Number(alerts?.with_incident ?? 0) },
    postmortems: { due: Number(postmortems?.due ?? 0), published: Number(postmortems?.published ?? 0) },
    services: services.map((s) => ({ id: s.id, name: s.name, tier: s.tier, availability: uptime.get(s.id) ?? 100, incidents: Number(byService.find((b) => b.service_id === s.id)?.n ?? 0) })),
  };
}

/* ------------------------------------------------------------------ deletion */

/**
 * Deletes a service that has never been part of an incident or shipped a deployment. One
 * with history is retired instead (isActive: false), so reports and postmortems still name it.
 */
export async function deleteService(actor: Actor, id: string) {
  if (!hasCapability(actor, 'reliability.manage') && !hasCapability(actor, 'engineering.manage')) throw forbidden();
  const svc = await one<{ name: string }>('SELECT name FROM services WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!svc) throw notFound('Service not found');
  const history = await one<{ incidents: number; deployments: number }>(
    'SELECT (SELECT COUNT(*) FROM incident_services WHERE service_id = $1) AS incidents, (SELECT COUNT(*) FROM deployments WHERE service_id = $1) AS deployments', [id]);
  if (Number(history?.incidents) || Number(history?.deployments)) {
    throw conflict('This service has incident or deployment history. Retire it instead so that history keeps its name.');
  }
  await pool.query('DELETE FROM services WHERE id = $1', [id]);
  await searchIndex.remove('service', id);
  await auditFromActor(actor, 'reliability.service.delete', { resourceType: 'service', resourceId: id, metadata: { name: svc.name } });
}

/** Removing a schedule an escalation policy still pages would leave that level paging nobody. */
export async function deleteSchedule(actor: Actor, id: string) {
  await requireManage(actor);
  const s = await one<{ name: string }>('SELECT name FROM oncall_schedules WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!s) throw notFound('Schedule not found');
  const policies = await many<{ name: string; levels: unknown }>('SELECT name, levels FROM escalation_policies WHERE company_id = $1', [actor.companyId]);
  const using = policies.filter((p) => parseJson<EscalationLevel[]>(p.levels, []).some((l) => l.targets.some((t) => t.type === 'schedule' && t.id === id))).map((p) => p.name);
  if (using.length) throw conflict(`Remove this schedule from ${using.join(', ')} first`);
  await pool.query('DELETE FROM oncall_schedules WHERE id = $1', [id]);
  await auditFromActor(actor, 'oncall.schedule.delete', { resourceType: 'oncall_schedule', resourceId: id, metadata: { name: s.name } });
}

export async function deletePolicy(actor: Actor, id: string) {
  await requireManage(actor);
  const p = await one<{ name: string }>('SELECT name FROM escalation_policies WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!p) throw notFound('Policy not found');
  const services = await many<{ name: string }>('SELECT name FROM services WHERE escalation_policy_id = $1', [id]);
  if (services.length) throw conflict(`${services.map((x) => x.name).join(', ')} ${services.length === 1 ? 'uses' : 'use'} this policy. Choose another policy for ${services.length === 1 ? 'it' : 'them'} first.`);
  if (await one("SELECT 1 FROM incidents WHERE escalation_policy_id = $1 AND status <> 'resolved'", [id])) throw conflict('An open incident is still escalating through this policy');
  await pool.query('DELETE FROM escalation_policies WHERE id = $1', [id]);
  await auditFromActor(actor, 'escalation.policy.delete', { resourceType: 'escalation_policy', resourceId: id, metadata: { name: p.name } });
}

/** An upcoming or cancelled window can be deleted; one that ran is part of the service's history. */
export async function deleteMaintenance(actor: Actor, id: string) {
  await requireManage(actor);
  const w = await one<{ title: string; status: string; starts_at: Date }>('SELECT title, status, starts_at FROM maintenance_windows WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!w) throw notFound('Maintenance window not found');
  if (w.status !== 'cancelled' && new Date(w.starts_at).getTime() <= Date.now()) throw conflict('This window has already started. Cancel it instead.');
  const services = await many<{ service_id: string }>('SELECT service_id FROM maintenance_services WHERE window_id = $1', [id]);
  await pool.query('DELETE FROM maintenance_windows WHERE id = $1', [id]);
  for (const s of services) await recomputeServiceStatus(s.service_id);
  await auditFromActor(actor, 'maintenance.delete', { resourceType: 'maintenance_window', resourceId: id, metadata: { title: w.title } });
}
