/**
 * Incidents: declaring, running and learning from them.
 *
 * Who may do what:
 *   reliability.read     see every incident and its internal timeline
 *   incident.declare     open one, join one as a responder
 *   responders           post internal updates, acknowledge, change status
 *   incident.manage /    everything, including severity, commander, and anything that
 *   commander            leaves the building: public status updates and the public title
 *
 * Paging follows the escalation policy of the first affected service that has one. Level
 * one is paged when the incident opens; each later level after its delay unless someone
 * has acknowledged; the whole policy repeats up to its repeat count. Acknowledging stops
 * it. The escalation clock is a column on the incident driven by a scheduled job, so an
 * API restart does not lose a page.
 */
import { many, newId, one, pool, transaction, type Queryable } from '../core/db.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { publishToUser } from '../core/realtime.js';
import * as notifications from './notifications.js';
import * as searchIndex from './search.js';
import { recomputeServiceStatus, resolveLevel } from './reliability.js';

export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type Impact = 'degraded' | 'partial_outage' | 'major_outage';

export const incidentRef = (n: number) => `INC-${n}`;

type IncidentRow = {
  id: string; company_id: string; number: number; title: string; severity: Severity; status: IncidentStatus;
  summary: string | null; customer_impact: string | null; commander_id: string | null; escalation_policy_id: string | null;
  escalation_level: number; escalation_round: number; escalation_next_at: Date | null;
  acknowledged_at: Date | null; acknowledged_by: string | null; detected_at: Date; mitigated_at: Date | null; resolved_at: Date | null;
  source: string; is_public: number; public_title: string | null; problem_ticket_id: string | null; created_by: string | null;
  version: number; created_at: Date; updated_at: Date;
};

async function load(actor: Actor, id: string, db: Queryable = pool) {
  if (actor.accessLevel === 'guest') throw forbidden();
  await authorize({ actor, capability: 'reliability.read', resourceless: true });
  const row = (await db.query<IncidentRow>('SELECT * FROM incidents WHERE id = $1 AND company_id = $2', [id, actor.companyId])).rows[0];
  if (!row) throw notFound('Incident not found');
  const responder = (await db.query('SELECT 1 FROM incident_responders WHERE incident_id = $1 AND user_id = $2', [id, actor.userId])).rows.length > 0;
  const lead = hasCapability(actor, 'incident.manage') || row.commander_id === actor.userId;
  return { row, responder: responder || lead, lead };
}

async function event(db: Queryable, incident: { id: string; company_id: string }, actorId: string | null, kind: string, body: string | null = null, visibility: 'internal' | 'public' = 'internal', status: string | null = null) {
  await db.query('INSERT INTO incident_events (incident_id, company_id, actor_id, kind, body, visibility, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [incident.id, incident.company_id, actorId, kind, body?.slice(0, 20000) ?? null, visibility, status]);
}

async function broadcast(incident: { id: string; company_id: string }) {
  const people = await many<{ user_id: string }>('SELECT user_id FROM incident_responders WHERE incident_id = $1', [incident.id]);
  for (const p of people) publishToUser(p.user_id, 'incident.updated', { id: incident.id });
}

async function index(i: IncidentRow) {
  await searchIndex.index({
    companyId: i.company_id, docType: 'incident', resourceId: i.id, title: `${incidentRef(i.number)} ${i.title}`,
    body: `${i.summary ?? ''} ${i.customer_impact ?? ''}`, aclCompanyWide: true, link: `/reliability/incidents/${i.id}`,
  });
}

/* ------------------------------------------------------------------- paging */

async function page(db: Queryable, incident: IncidentRow, levelIndex: number): Promise<number> {
  if (!incident.escalation_policy_id) return 0;
  const level = await resolveLevel(incident.company_id, incident.escalation_policy_id, levelIndex);
  for (const userId of level.userIds) {
    await db.query(
      `INSERT INTO incident_responders (incident_id, user_id, role, paged_at) VALUES ($1,$2,'responder',NOW(3))
       ON DUPLICATE KEY UPDATE paged_at = NOW(3)`, [incident.id, userId]);
    await notifications.create({
      companyId: incident.company_id, userId, type: 'incident.paged',
      title: `${incident.severity.toUpperCase()} ${incidentRef(incident.number)}: ${incident.title}`.slice(0, 300),
      body: 'You are being paged. Acknowledge to stop escalation.', link: `/reliability/incidents/${incident.id}`,
      resourceType: 'incident', resourceId: incident.id,
      dedupeKey: `incident-page:${incident.id}:${incident.escalation_round}:${levelIndex}:${userId}`,
    }, db);
  }
  await emit({ companyId: incident.company_id, type: 'incident.paged', payload: { incidentId: incident.id, userIds: level.userIds, level: levelIndex + 1 } }, db);
  await event(db, incident, null, 'paged', level.userIds.length
    ? `Paged level ${levelIndex + 1}${incident.escalation_round ? ` (repeat ${incident.escalation_round})` : ''}`
    : `Level ${levelIndex + 1} had nobody on call to page`);
  // When the next level fires, or when the policy starts over.
  const nextDelay = level.delayMinutes ?? (incident.escalation_round < level.repeatCount ? Math.max(5, (await resolveLevel(incident.company_id, incident.escalation_policy_id, 1)).delayMinutes ?? 15) : null);
  await db.query('UPDATE incidents SET escalation_level = $2, escalation_next_at = $3 WHERE id = $1',
    [incident.id, levelIndex, nextDelay === null ? null : new Date(Date.now() + nextDelay * 60_000)]);
  return level.userIds.length;
}

/** Scheduled every minute: pages the next level for unacknowledged incidents whose time has come. */
export async function escalate(): Promise<number> {
  const due = await many<IncidentRow>(
    `SELECT * FROM incidents WHERE status <> 'resolved' AND acknowledged_at IS NULL
        AND escalation_next_at IS NOT NULL AND escalation_next_at <= NOW(3) LIMIT 50`);
  let paged = 0;
  for (const incident of due) {
    // Claim it: a second scheduler instance racing on the same row changes nothing.
    const claim = await pool.query('UPDATE incidents SET escalation_next_at = NULL WHERE id = $1 AND escalation_next_at = $2', [incident.id, incident.escalation_next_at]);
    if (claim.rowCount === 0 || !incident.escalation_policy_id) continue;
    const next = incident.escalation_level + 1;
    const probe = await resolveLevel(incident.company_id, incident.escalation_policy_id, next);
    if (next < probe.levelCount) {
      paged += await page(pool, incident, next);
    } else if (incident.escalation_round < probe.repeatCount) {
      await pool.query('UPDATE incidents SET escalation_round = escalation_round + 1 WHERE id = $1', [incident.id]);
      paged += await page(pool, { ...incident, escalation_round: incident.escalation_round + 1 }, 0);
    } else {
      await event(pool, incident, null, 'escalation_exhausted', 'Every escalation level has been paged and nobody acknowledged');
      const leads = await many<{ id: string }>(
        `SELECT u.id FROM users u JOIN role_capabilities rc ON rc.role = u.access_level AND rc.capability = 'incident.manage'
          WHERE u.company_id = $1 AND u.status = 'active'`, [incident.company_id]);
      for (const l of leads) {
        await notifications.create({
          companyId: incident.company_id, userId: l.id, type: 'incident.paged',
          title: `Nobody acknowledged ${incidentRef(incident.number)}`, body: incident.title,
          link: `/reliability/incidents/${incident.id}`, resourceType: 'incident', resourceId: incident.id,
          dedupeKey: `incident-exhausted:${incident.id}:${l.id}`,
        });
      }
    }
    await broadcast(incident);
  }
  return paged;
}

/* ---------------------------------------------------------------- declaring */

export type DeclareInput = {
  title: string;
  severity: Severity;
  summary?: string | null;
  services: { serviceId: string; impact: Impact }[];
  commanderId?: string | null;
};

export async function declareIncident(actor: Actor, input: DeclareInput, source: 'manual' | 'alert' | 'heartbeat' = 'manual') {
  if (source === 'manual') {
    if (actor.accessLevel === 'guest') throw forbidden();
    await authorize({ actor, capability: 'incident.declare', resourceless: true });
  }
  if (input.services.length === 0) throw unprocessable('Choose at least one affected service', [{ field: 'services', message: 'Required' }]);
  const services: { id: string; escalation_policy_id: string | null; tier: string; impact: Impact }[] = [];
  for (const s of input.services) {
    const row = await one<{ id: string; escalation_policy_id: string | null; tier: string }>('SELECT id, escalation_policy_id, tier FROM services WHERE id = $1 AND company_id = $2', [s.serviceId, actor.companyId]);
    if (!row) throw unprocessable('Service not found', [{ field: 'services', message: 'Choose again' }]);
    services.push({ ...row, impact: s.impact });
  }
  if (input.commanderId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active' AND access_level <> 'guest'", [input.commanderId, actor.companyId]))) {
    throw unprocessable('Commander not found', [{ field: 'commanderId', message: 'Choose an active employee' }]);
  }
  // The most critical affected service that has a policy decides who gets paged.
  const rank: Record<string, number> = { critical: 0, high: 1, standard: 2 };
  const policyId = [...services].sort((a, b) => rank[a.tier]! - rank[b.tier]!).find((s) => s.escalation_policy_id)?.escalation_policy_id ?? null;
  const humanActor = source === 'manual' ? actor.userId : null;

  const incident = await transaction(async (tx) => {
    await tx.query('INSERT IGNORE INTO incident_counters (company_id, next_number) VALUES ($1, 1)', [actor.companyId]);
    const n = Number((await tx.query<{ next_number: number }>('SELECT next_number FROM incident_counters WHERE company_id = $1 FOR UPDATE', [actor.companyId])).rows[0]!.next_number);
    await tx.query('UPDATE incident_counters SET next_number = next_number + 1 WHERE company_id = $1', [actor.companyId]);
    const id = newId();
    await tx.query(
      `INSERT INTO incidents (id, company_id, number, title, severity, summary, commander_id, escalation_policy_id, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, actor.companyId, n, input.title.trim(), input.severity, input.summary?.trim() || null, input.commanderId ?? humanActor, policyId, source, humanActor]);
    for (const s of services) await tx.query('INSERT INTO incident_services (incident_id, service_id, impact) VALUES ($1,$2,$3)', [id, s.id, s.impact]);
    const commander = input.commanderId ?? humanActor;
    if (commander) await tx.query("INSERT INTO incident_responders (incident_id, user_id, role) VALUES ($1,$2,'commander')", [id, commander]);
    if (humanActor && humanActor !== commander) await tx.query("INSERT INTO incident_responders (incident_id, user_id, role) VALUES ($1,$2,'responder')", [id, humanActor]);
    const row = (await tx.query<IncidentRow>('SELECT * FROM incidents WHERE id = $1', [id])).rows[0]!;
    await event(tx, row, humanActor, 'declared', input.summary?.trim() || null, 'internal', 'investigating');
    if (source === 'manual') await auditFromActor(actor, 'incident.declare', { resourceType: 'incident', resourceId: id, metadata: { number: n, severity: input.severity, services: services.length } }, tx);
    return row;
  });

  for (const s of services) await recomputeServiceStatus(s.id);
  if (policyId) await page(pool, incident, 0);
  await index(incident);
  await broadcast(incident);
  return incident;
}

/* ------------------------------------------------------------------ reading */

export async function listIncidents(actor: Actor, filter: { status?: 'open' | 'resolved' | 'all'; serviceId?: string; limit: number }) {
  if (actor.accessLevel === 'guest') throw forbidden();
  await authorize({ actor, capability: 'reliability.read', resourceless: true });
  const where = ['i.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  if (filter.status === 'open' || !filter.status) where.push("i.status <> 'resolved'");
  if (filter.status === 'resolved') where.push("i.status = 'resolved'");
  if (filter.serviceId) { params.push(filter.serviceId); where.push(`EXISTS (SELECT 1 FROM incident_services x WHERE x.incident_id = i.id AND x.service_id = $${params.length})`); }
  params.push(filter.limit);
  const rows = await many<IncidentRow & { commander_name: string | null; services: string | null; responder_count: number }>(
    `SELECT i.*, u.display_name AS commander_name,
            (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR ', ') FROM incident_services x JOIN services s ON s.id = x.service_id WHERE x.incident_id = i.id) AS services,
            (SELECT COUNT(*) FROM incident_responders r WHERE r.incident_id = i.id) AS responder_count
       FROM incidents i LEFT JOIN users u ON u.id = i.commander_id
      WHERE ${where.join(' AND ')}
      ORDER BY (i.status = 'resolved'), FIELD(i.severity, 'sev1','sev2','sev3','sev4'), i.detected_at DESC
      LIMIT $${params.length}`, params);
  return rows.map((i) => ({
    id: i.id, ref: incidentRef(i.number), title: i.title, severity: i.severity, status: i.status, source: i.source,
    commanderName: i.commander_name, services: i.services ?? '', responders: Number(i.responder_count),
    detectedAt: i.detected_at, acknowledgedAt: i.acknowledged_at, resolvedAt: i.resolved_at, isPublic: Boolean(i.is_public),
  }));
}

export async function getIncident(actor: Actor, id: string) {
  const { row: i, responder, lead } = await load(actor, id);
  const services = await many<{ id: string; name: string; impact: Impact; status: string }>(
    'SELECT s.id, s.name, x.impact, s.status FROM incident_services x JOIN services s ON s.id = x.service_id WHERE x.incident_id = $1 ORDER BY s.name', [id]);
  const responders = await many<{ id: string; display_name: string; role: string; paged_at: Date | null; joined_at: Date }>(
    'SELECT u.id, u.display_name, r.role, r.paged_at, r.joined_at FROM incident_responders r JOIN users u ON u.id = r.user_id WHERE r.incident_id = $1 ORDER BY r.joined_at', [id]);
  const events = await many<{ id: number; kind: string; body: string | null; visibility: string; status: string | null; created_at: Date; actor_name: string | null }>(
    'SELECT e.id, e.kind, e.body, e.visibility, e.status, e.created_at, u.display_name AS actor_name FROM incident_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.incident_id = $1 ORDER BY e.id', [id]);
  const alerts = await many<{ id: string; title: string; severity: string; status: string; occurrences: number; first_seen_at: Date; last_seen_at: Date; source_url: string | null }>(
    'SELECT id, title, severity, status, occurrences, first_seen_at, last_seen_at, source_url FROM alerts WHERE incident_id = $1 ORDER BY first_seen_at', [id]);
  const tickets = await many<{ id: string; number: number; subject: string; status: string; type: string }>(
    'SELECT t.id, t.number, t.subject, t.status, t.type FROM incident_tickets l JOIN tickets t ON t.id = l.ticket_id WHERE l.incident_id = $1 ORDER BY l.linked_at', [id]);
  const problem = i.problem_ticket_id ? await one<{ id: string; number: number; subject: string; status: string }>('SELECT id, number, subject, status FROM tickets WHERE id = $1', [i.problem_ticket_id]) : null;
  const commander = responders.find((r) => r.id === i.commander_id);
  const postmortem = await one<{ status: string }>('SELECT status FROM postmortems WHERE incident_id = $1', [id]);
  return {
    id: i.id, ref: incidentRef(i.number), title: i.title, severity: i.severity, status: i.status, summary: i.summary,
    customerImpact: i.customer_impact, source: i.source, detectedAt: i.detected_at, acknowledgedAt: i.acknowledged_at,
    mitigatedAt: i.mitigated_at, resolvedAt: i.resolved_at, isPublic: Boolean(i.is_public), publicTitle: i.public_title,
    commander: commander ? { id: commander.id, name: commander.display_name } : null,
    escalation: i.escalation_policy_id ? { level: i.escalation_level + 1, round: i.escalation_round, nextAt: i.escalation_next_at } : null,
    services: services.map((s) => ({ id: s.id, name: s.name, impact: s.impact, status: s.status })),
    responders: responders.map((r) => ({ id: r.id, name: r.display_name, role: r.role, pagedAt: r.paged_at, joinedAt: r.joined_at })),
    events: events.map((e) => ({ id: Number(e.id), kind: e.kind, body: e.body, visibility: e.visibility, status: e.status, createdAt: e.created_at, actorName: e.actor_name })),
    alerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, occurrences: Number(a.occurrences), firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at, sourceUrl: a.source_url })),
    tickets: tickets.map((t) => ({ id: t.id, ref: `SD-${t.number}`, subject: t.subject, status: t.status, type: t.type })),
    problem: problem ? { id: problem.id, ref: `SD-${problem.number}`, subject: problem.subject, status: problem.status } : null,
    postmortemStatus: postmortem?.status ?? null,
    version: i.version,
    permissions: {
      isResponder: responder,
      canJoin: !responder && hasCapability(actor, 'incident.declare') && i.status !== 'resolved',
      canUpdate: responder,
      canLead: lead,
      canAcknowledge: responder && !i.acknowledged_at && i.status !== 'resolved',
    },
  };
}

/* ----------------------------------------------------------------- running */

export async function updateIncident(actor: Actor, id: string, input: {
  status?: IncidentStatus; severity?: Severity; title?: string; summary?: string | null; customerImpact?: string | null;
  commanderId?: string | null; isPublic?: boolean; publicTitle?: string | null;
  services?: { serviceId: string; impact: Impact }[];
}, expectedVersion?: number) {
  const { row: i, responder, lead } = await load(actor, id);
  if (!responder) throw forbidden('Join the incident to update it');
  const leadOnly = ['severity', 'commanderId', 'isPublic', 'publicTitle', 'title', 'services'] as const;
  if (!lead && leadOnly.some((k) => input[k] !== undefined)) throw forbidden('Only the incident commander or an incident manager can change that');
  if (expectedVersion !== undefined && expectedVersion !== i.version) throw preconditionFailed('The incident changed since you opened it. Reload to see the latest.');
  if (input.commanderId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active' AND access_level <> 'guest'", [input.commanderId, actor.companyId]))) {
    throw unprocessable('Commander not found', [{ field: 'commanderId', message: 'Choose an active employee' }]);
  }
  if (input.services) {
    if (input.services.length === 0) throw unprocessable('An incident needs at least one affected service');
    for (const s of input.services) if (!(await one('SELECT 1 FROM services WHERE id = $1 AND company_id = $2', [s.serviceId, actor.companyId]))) throw unprocessable('Service not found');
  }
  const previousServices = (await many<{ service_id: string }>('SELECT service_id FROM incident_services WHERE incident_id = $1', [id])).map((s) => s.service_id);
  const status = input.status ?? i.status;

  await transaction(async (tx) => {
    const res = await tx.query(
      `UPDATE incidents SET
         mitigated_at = CASE WHEN $4 IN ('monitoring','resolved') AND mitigated_at IS NULL THEN NOW(3) ELSE mitigated_at END,
         resolved_at = CASE WHEN $4 = 'resolved' AND status <> 'resolved' THEN NOW(3) WHEN $4 <> 'resolved' THEN NULL ELSE resolved_at END,
         escalation_next_at = CASE WHEN $4 = 'resolved' THEN NULL ELSE escalation_next_at END,
         status = $4, severity = $5, title = $6, summary = $7, customer_impact = $8, commander_id = $9,
         is_public = $10, public_title = $11, version = version + 1
       WHERE id = $1 AND company_id = $2 AND version = $3`,
      [id, actor.companyId, i.version, status, input.severity ?? i.severity, input.title?.trim() ?? i.title,
        input.summary !== undefined ? input.summary?.trim() || null : i.summary,
        input.customerImpact !== undefined ? input.customerImpact?.trim() || null : i.customer_impact,
        input.commanderId !== undefined ? input.commanderId : i.commander_id,
        input.isPublic ?? Boolean(i.is_public), input.publicTitle !== undefined ? input.publicTitle?.trim() || null : i.public_title]);
    if (res.rowCount === 0) throw preconditionFailed('The incident changed since you opened it. Reload to see the latest.');
    if (status !== i.status) await event(tx, i, actor.userId, 'status', null, 'internal', status);
    if (input.severity && input.severity !== i.severity) await event(tx, i, actor.userId, 'severity', `${i.severity.toUpperCase()} → ${input.severity.toUpperCase()}`);
    if (input.commanderId !== undefined && input.commanderId !== i.commander_id) {
      if (input.commanderId) {
        await tx.query(`INSERT INTO incident_responders (incident_id, user_id, role) VALUES ($1,$2,'commander') ON DUPLICATE KEY UPDATE role = 'commander'`, [id, input.commanderId]);
      }
      if (i.commander_id) await tx.query("UPDATE incident_responders SET role = 'responder' WHERE incident_id = $1 AND user_id = $2", [id, i.commander_id]);
      await event(tx, i, actor.userId, 'commander', null);
    }
    if (input.isPublic !== undefined && input.isPublic !== Boolean(i.is_public)) await event(tx, i, actor.userId, input.isPublic ? 'made_public' : 'made_internal');
    if (input.services) {
      await tx.query('DELETE FROM incident_services WHERE incident_id = $1', [id]);
      for (const s of input.services) await tx.query('INSERT INTO incident_services (incident_id, service_id, impact) VALUES ($1,$2,$3)', [id, s.serviceId, s.impact]);
      await event(tx, i, actor.userId, 'services', input.services.map((s) => s.impact).join(', '));
    }
    await auditFromActor(actor, 'incident.update', { resourceType: 'incident', resourceId: id, metadata: { changes: Object.keys(input) } }, tx);
  });
  for (const s of new Set([...previousServices, ...(input.services ?? []).map((x) => x.serviceId)])) await recomputeServiceStatus(s);
  const fresh = (await one<IncidentRow>('SELECT * FROM incidents WHERE id = $1', [id]))!;
  await index(fresh);
  await broadcast(fresh);
  return getIncident(actor, id);
}

export async function postUpdate(actor: Actor, id: string, input: { body: string; visibility: 'internal' | 'public'; status?: IncidentStatus }) {
  const { row: i, responder, lead } = await load(actor, id);
  if (!responder) throw forbidden('Join the incident to post updates');
  if (input.visibility === 'public' && !lead) throw forbidden('Only the incident commander or an incident manager can publish status updates');
  if (input.visibility === 'public' && !i.is_public) throw conflict('Make the incident public before publishing a status update');
  if (input.status && input.status !== i.status) await updateIncident(actor, id, { status: input.status });
  await event(pool, i, actor.userId, input.visibility === 'public' ? 'public_update' : 'note', input.body.trim(), input.visibility, input.status ?? null);
  await auditFromActor(actor, input.visibility === 'public' ? 'incident.status_update' : 'incident.note', { resourceType: 'incident', resourceId: id });
  await broadcast(i);
  return getIncident(actor, id);
}

export async function acknowledge(actor: Actor, id: string) {
  const { row: i, responder } = await load(actor, id);
  if (!responder) throw forbidden('Only people responding to the incident can acknowledge it');
  if (i.acknowledged_at) return getIncident(actor, id);
  const res = await pool.query('UPDATE incidents SET acknowledged_at = NOW(3), acknowledged_by = $2, escalation_next_at = NULL WHERE id = $1 AND acknowledged_at IS NULL', [id, actor.userId]);
  if (res.rowCount > 0) {
    await event(pool, i, actor.userId, 'acknowledged', 'Escalation stopped');
    await auditFromActor(actor, 'incident.acknowledge', { resourceType: 'incident', resourceId: id });
  }
  await broadcast(i);
  return getIncident(actor, id);
}

export async function join(actor: Actor, id: string, role: 'responder' | 'communications' | 'subject_expert' = 'responder') {
  const { row: i } = await load(actor, id);
  await authorize({ actor, capability: 'incident.declare', resourceless: true });
  if (i.status === 'resolved') throw conflict('This incident is resolved');
  await pool.query('INSERT IGNORE INTO incident_responders (incident_id, user_id, role) VALUES ($1,$2,$3)', [id, actor.userId, role]);
  await event(pool, i, actor.userId, 'joined', role);
  await broadcast(i);
  return getIncident(actor, id);
}

export async function addResponder(actor: Actor, id: string, userId: string) {
  const { row: i, lead } = await load(actor, id);
  if (!lead) throw forbidden('Only the incident commander or an incident manager can bring people in');
  if (!(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active' AND access_level <> 'guest'", [userId, actor.companyId]))) {
    throw unprocessable('Person not found', [{ field: 'userId', message: 'Choose an active employee' }]);
  }
  await pool.query(`INSERT INTO incident_responders (incident_id, user_id, role, paged_at) VALUES ($1,$2,'responder',NOW(3)) ON DUPLICATE KEY UPDATE paged_at = NOW(3)`, [id, userId]);
  await notifications.create({
    companyId: i.company_id, userId, type: 'incident.paged', title: `You were added to ${incidentRef(i.number)}: ${i.title}`.slice(0, 300),
    body: `${actor.displayName} needs your help`, link: `/reliability/incidents/${id}`, resourceType: 'incident', resourceId: id,
    dedupeKey: `incident-add:${id}:${userId}:${Date.now()}`,
  });
  await event(pool, i, actor.userId, 'responder_added', null);
  await broadcast(i);
  return getIncident(actor, id);
}

/* ----------------------------------------------------- service desk links */

export async function linkTicket(actor: Actor, id: string, ticketId: string, remove = false) {
  const { row: i, responder } = await load(actor, id);
  if (!responder) throw forbidden('Join the incident to link tickets');
  const { getTicket } = await import('./service.js');
  const t = await getTicket(actor, ticketId);
  if (remove) await pool.query('DELETE FROM incident_tickets WHERE incident_id = $1 AND ticket_id = $2', [id, ticketId]);
  else await pool.query('INSERT IGNORE INTO incident_tickets (incident_id, ticket_id, linked_by) VALUES ($1,$2,$3)', [id, ticketId, actor.userId]);
  await event(pool, i, actor.userId, remove ? 'ticket_unlinked' : 'ticket_linked', `${t.ref} ${t.subject}`);
  return getIncident(actor, id);
}

/** Opens a problem ticket in the affected service's support queue and links it. */
export async function createProblem(actor: Actor, id: string, input: { queueId?: string | null }) {
  const { row: i, lead } = await load(actor, id);
  if (!lead) throw forbidden('Only the incident commander or an incident manager can open the problem record');
  if (i.problem_ticket_id) throw conflict('This incident already has a problem ticket');
  const queue = input.queueId ?? (await one<{ support_queue_id: string | null }>(
    `SELECT s.support_queue_id FROM incident_services x JOIN services s ON s.id = x.service_id
      WHERE x.incident_id = $1 AND s.support_queue_id IS NOT NULL ORDER BY FIELD(s.tier,'critical','high','standard') LIMIT 1`, [id]))?.support_queue_id;
  if (!queue || !(await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2 AND is_active = 1', [queue, actor.companyId]))) {
    throw unprocessable('Choose a service desk queue for the problem ticket', [{ field: 'queueId', message: 'No support queue is set on the affected services' }]);
  }
  const { insertTicket } = await import('./service.js');
  const ticket = await insertTicket(actor, {
    subject: `Problem: ${i.title}`.slice(0, 300),
    description: `Opened from ${incidentRef(i.number)} to find and remove the underlying cause.\n\n${i.summary ?? ''}`.trim(),
    type: 'problem', priority: i.severity === 'sev1' ? 'urgent' : i.severity === 'sev2' ? 'high' : 'normal',
    queueId: queue, categoryId: null, requesterId: actor.userId, clientOrgId: null, channel: 'workspace',
  });
  await pool.query('UPDATE incidents SET problem_ticket_id = $2 WHERE id = $1', [id, ticket.id]);
  await pool.query('INSERT IGNORE INTO incident_tickets (incident_id, ticket_id, linked_by) VALUES ($1,$2,$3)', [id, ticket.id, actor.userId]);
  await event(pool, i, actor.userId, 'problem_opened', `SD-${ticket.number} ${ticket.subject}`);
  await auditFromActor(actor, 'incident.problem.create', { resourceType: 'incident', resourceId: id, metadata: { ticketId: ticket.id } });
  return getIncident(actor, id);
}

/* ------------------------------------------------------------- postmortems */

export async function getPostmortem(actor: Actor, id: string) {
  const { row: i, responder, lead } = await load(actor, id);
  const pm = await one<{ summary: string | null; impact: string | null; root_cause: string | null; went_well: string | null; went_wrong: string | null; lessons: string | null; status: string; author_name: string | null; published_at: Date | null; version: number; updated_at: Date }>(
    'SELECT p.*, u.display_name AS author_name FROM postmortems p LEFT JOIN users u ON u.id = p.author_id WHERE p.incident_id = $1', [id]);
  const actions = await many<{ id: string; title: string; owner_name: string | null; task_id: string | null; task_status: string | null; task_ref: string | null }>(
    `SELECT a.id, a.title, u.display_name AS owner_name, a.task_id, t.status AS task_status, CONCAT(p.key, '-', t.number) AS task_ref
       FROM postmortem_actions a LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN projects p ON p.id = t.project_id
      WHERE a.incident_id = $1 ORDER BY a.created_at`, [id]);
  const timeline = await many<{ kind: string; body: string | null; created_at: Date; actor_name: string | null }>(
    `SELECT e.kind, e.body, e.created_at, u.display_name AS actor_name FROM incident_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.incident_id = $1 AND e.kind IN ('declared','paged','acknowledged','status','severity','public_update','note','problem_opened','escalation_exhausted') ORDER BY e.id`, [id]);
  return {
    incident: { id: i.id, ref: incidentRef(i.number), title: i.title, severity: i.severity, status: i.status, detectedAt: i.detected_at, acknowledgedAt: i.acknowledged_at, mitigatedAt: i.mitigated_at, resolvedAt: i.resolved_at },
    postmortem: pm ? { summary: pm.summary, impact: pm.impact, rootCause: pm.root_cause, wentWell: pm.went_well, wentWrong: pm.went_wrong, lessons: pm.lessons, status: pm.status, authorName: pm.author_name, publishedAt: pm.published_at, version: pm.version, updatedAt: pm.updated_at } : null,
    actions: actions.map((a) => ({ id: a.id, title: a.title, ownerName: a.owner_name, taskId: a.task_id, taskStatus: a.task_status, taskRef: a.task_ref })),
    timeline: timeline.map((t) => ({ kind: t.kind, body: t.body, createdAt: t.created_at, actorName: t.actor_name })),
    canEdit: responder || lead,
    canPublish: lead,
  };
}

export async function savePostmortem(actor: Actor, id: string, input: { summary?: string | null; impact?: string | null; rootCause?: string | null; wentWell?: string | null; wentWrong?: string | null; lessons?: string | null }, publish = false) {
  const { row: i, responder, lead } = await load(actor, id);
  if (!responder) throw forbidden('Join the incident to write its postmortem');
  if (publish && !lead) throw forbidden('Only the incident commander or an incident manager can publish the postmortem');
  if (i.status !== 'resolved') throw conflict('Resolve the incident before writing its postmortem');
  const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
  const existing = await one<{ status: string }>('SELECT status FROM postmortems WHERE incident_id = $1', [id]);
  if (publish && !(input.rootCause ?? (await one<{ root_cause: string | null }>('SELECT root_cause FROM postmortems WHERE incident_id = $1', [id]))?.root_cause)) {
    throw unprocessable('Record the root cause before publishing', [{ field: 'rootCause', message: 'Required to publish' }]);
  }
  await pool.query(
    `INSERT INTO postmortems (incident_id, company_id, summary, impact, root_cause, went_well, went_wrong, lessons, status, author_id, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON DUPLICATE KEY UPDATE
       summary = COALESCE($12, summary), impact = COALESCE($13, impact), root_cause = COALESCE($14, root_cause),
       went_well = COALESCE($15, went_well), went_wrong = COALESCE($16, went_wrong), lessons = COALESCE($17, lessons),
       status = CASE WHEN $18 THEN 'published' ELSE status END,
       published_at = CASE WHEN $18 AND published_at IS NULL THEN NOW(3) ELSE published_at END,
       version = version + 1`,
    [id, actor.companyId, clean(input.summary) ?? null, clean(input.impact) ?? null, clean(input.rootCause) ?? null, clean(input.wentWell) ?? null, clean(input.wentWrong) ?? null, clean(input.lessons) ?? null,
      publish ? 'published' : 'draft', actor.userId, publish ? new Date() : null,
      clean(input.summary) ?? null, clean(input.impact) ?? null, clean(input.rootCause) ?? null, clean(input.wentWell) ?? null, clean(input.wentWrong) ?? null, clean(input.lessons) ?? null, publish]);
  if (publish && existing?.status !== 'published') await event(pool, i, actor.userId, 'postmortem_published');
  await auditFromActor(actor, publish ? 'postmortem.publish' : 'postmortem.save', { resourceType: 'incident', resourceId: id });
  return getPostmortem(actor, id);
}

/** An action item becomes a real task, so follow-up lives on a board rather than in a document. */
export async function addAction(actor: Actor, id: string, input: { title: string; projectId: string; ownerId?: string | null }, correlationId: string) {
  const { row: i, responder } = await load(actor, id);
  if (!responder) throw forbidden('Join the incident to add action items');
  const { createTask } = await import('./tasks.js');
  const task = await createTask(actor, input.projectId, {
    title: input.title.trim().slice(0, 300),
    description: `Follow-up from the postmortem for ${incidentRef(i.number)}: ${i.title}`,
    assigneeId: input.ownerId ?? null,
    priority: i.severity === 'sev1' || i.severity === 'sev2' ? 'high' : 'medium',
  }, correlationId);
  const actionId = newId();
  await pool.query('INSERT INTO postmortem_actions (id, incident_id, company_id, title, owner_id, task_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [actionId, id, actor.companyId, input.title.trim(), input.ownerId ?? null, task.id, actor.userId]);
  await auditFromActor(actor, 'postmortem.action.create', { resourceType: 'incident', resourceId: id, metadata: { taskId: task.id } });
  return getPostmortem(actor, id);
}

/** Open incidents for the command centre. */
export async function openForDashboard(actor: Actor) {
  if (!hasCapability(actor, 'reliability.read')) return null;
  const rows = await many<{ id: string; number: number; title: string; severity: Severity; status: IncidentStatus; acknowledged_at: Date | null; mine: number }>(
    `SELECT i.id, i.number, i.title, i.severity, i.status, i.acknowledged_at,
            EXISTS (SELECT 1 FROM incident_responders r WHERE r.incident_id = i.id AND r.user_id = $2) AS mine
       FROM incidents i WHERE i.company_id = $1 AND i.status <> 'resolved'
      ORDER BY FIELD(i.severity,'sev1','sev2','sev3','sev4'), i.detected_at DESC LIMIT 8`, [actor.companyId, actor.userId]);
  const degraded = await many<{ id: string; name: string; status: string }>(
    "SELECT id, name, status FROM services WHERE company_id = $1 AND is_active = 1 AND status <> 'operational' ORDER BY FIELD(status,'major_outage','partial_outage','degraded','maintenance')", [actor.companyId]);
  const total = await one<{ n: number }>('SELECT COUNT(*) AS n FROM services WHERE company_id = $1 AND is_active = 1', [actor.companyId]);
  return {
    incidents: rows.map((r) => ({ id: r.id, ref: incidentRef(r.number), title: r.title, severity: r.severity, status: r.status, acknowledged: Boolean(r.acknowledged_at), mine: Boolean(r.mine) })),
    services: { total: Number(total?.n ?? 0), notOperational: degraded },
  };
}
