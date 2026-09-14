/**
 * Alert intake from the monitoring tools a company already runs.
 *
 * Two kinds of integration belong to a service:
 *
 *   webhook    The tool POSTs JSON to /reliability/alerts/<key>, signed with HMAC-SHA256 of
 *              `timestamp.body` under the integration's secret (the same scheme as
 *              email-to-ticket). Body:
 *                { "fingerprint": "disk-full-db1", "title": "...", "severity": "critical" |
 *                  "warning" | "info", "status": "firing" | "resolved", "details": "...",
 *                  "url": "https://grafana.example/..." }
 *              The fingerprint is the sender's name for "the same problem": repeats update
 *              one alert instead of creating many.
 *
 *   heartbeat  A job calls /reliability/heartbeat/<key> while it is healthy. The key is
 *              the credential - 32 random hex characters - because cron jobs cannot sign
 *              requests. Missing the interval raises a critical alert.
 *
 * What an alert does:
 *   - During a maintenance window that suppresses alerts on the service, it is recorded
 *     and marked suppressed. Nobody is paged.
 *   - At or above the integration's incident threshold, it joins the service's open
 *     alert-sourced incident if there is one, otherwise opens a new incident (critical ->
 *     SEV2 partial outage, warning -> SEV3 degraded), which pages the escalation policy.
 *   - A resolved alert is closed. When every alert on an incident has resolved, the
 *     timeline says so, but the incident stays open: a person decides it is over.
 */
import { randomBytes } from 'node:crypto';
import { many, newId, one, pool } from '../core/db.js';
import { conflict, forbidden, notFound, unauthenticated, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { decryptField, encryptField, generateToken, hmacSignature, safeEqual, sha256 } from '../core/crypto.js';
import { logger } from '../core/logger.js';
import { inMaintenance } from './reliability.js';

const MAX_SKEW_SECONDS = 300;

type IntegrationRow = {
  id: string; company_id: string; service_id: string; name: string; kind: 'webhook' | 'heartbeat';
  endpoint_key: string; secret_encrypted: string; incident_severity: 'critical' | 'warning' | null;
  heartbeat_minutes: number | null; last_received_at: Date | null; heartbeat_missed_at: Date | null; is_active: number;
};

export async function createIntegration(actor: Actor, serviceId: string, input: { name: string; kind: 'webhook' | 'heartbeat'; incidentSeverity?: 'critical' | 'warning' | null; heartbeatMinutes?: number | null }) {
  await authorize({ actor, capability: 'reliability.manage', resourceless: true });
  if (!(await one('SELECT 1 FROM services WHERE id = $1 AND company_id = $2', [serviceId, actor.companyId]))) throw notFound('Service not found');
  if (input.kind === 'heartbeat' && !input.heartbeatMinutes) {
    throw unprocessable('Say how often the heartbeat is expected', [{ field: 'heartbeatMinutes', message: 'Required for heartbeats' }]);
  }
  const id = newId();
  const secret = generateToken(32);
  const endpointKey = randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO alert_integrations (id, company_id, service_id, name, kind, endpoint_key, secret_encrypted, secret_fingerprint, incident_severity, heartbeat_minutes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, actor.companyId, serviceId, input.name.trim(), input.kind, endpointKey, encryptField(secret), sha256(secret).slice(0, 12),
      input.kind === 'heartbeat' ? 'critical' : input.incidentSeverity === undefined ? 'critical' : input.incidentSeverity,
      input.kind === 'heartbeat' ? input.heartbeatMinutes : null, actor.userId],
  );
  await auditFromActor(actor, 'reliability.integration.create', { resourceType: 'alert_integration', resourceId: id, metadata: { serviceId, kind: input.kind } });
  const { config } = await import('../core/config.js');
  return {
    id,
    endpoint: input.kind === 'heartbeat' ? `${config.apiUrl}/api/v1/reliability/heartbeat/${endpointKey}` : `${config.apiUrl}/api/v1/reliability/alerts/${endpointKey}`,
    // A webhook needs the secret to sign; a heartbeat's URL is its credential. Shown once.
    secret: input.kind === 'webhook' ? secret : null,
  };
}

export async function updateIntegration(actor: Actor, id: string, input: { name?: string; isActive?: boolean; incidentSeverity?: 'critical' | 'warning' | null; heartbeatMinutes?: number; rotate?: boolean }) {
  await authorize({ actor, capability: 'reliability.manage', resourceless: true });
  const row = await one<IntegrationRow>('SELECT * FROM alert_integrations WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!row) throw notFound('Integration not found');
  let secret: string | null = null;
  let endpointKey = row.endpoint_key;
  if (input.rotate) {
    secret = generateToken(32);
    // A heartbeat's URL is its secret, so rotating replaces the URL.
    if (row.kind === 'heartbeat') endpointKey = randomBytes(16).toString('hex');
  }
  await pool.query(
    `UPDATE alert_integrations SET name = COALESCE($3, name), is_active = COALESCE($4, is_active),
       incident_severity = CASE WHEN $5 THEN $6 ELSE incident_severity END,
       heartbeat_minutes = COALESCE($7, heartbeat_minutes),
       secret_encrypted = COALESCE($8, secret_encrypted), secret_fingerprint = COALESCE($9, secret_fingerprint), endpoint_key = $10
     WHERE id = $1 AND company_id = $2`,
    [id, actor.companyId, input.name?.trim() ?? null, input.isActive === undefined ? null : input.isActive,
      input.incidentSeverity !== undefined && row.kind === 'webhook', input.incidentSeverity ?? null,
      row.kind === 'heartbeat' ? input.heartbeatMinutes ?? null : null,
      secret ? encryptField(secret) : null, secret ? sha256(secret).slice(0, 12) : null, endpointKey],
  );
  await auditFromActor(actor, input.rotate ? 'reliability.integration.rotate' : 'reliability.integration.update', { resourceType: 'alert_integration', resourceId: id, metadata: { changes: Object.keys(input) } });
  const { config } = await import('../core/config.js');
  return {
    id,
    endpoint: row.kind === 'heartbeat' ? `${config.apiUrl}/api/v1/reliability/heartbeat/${endpointKey}` : `${config.apiUrl}/api/v1/reliability/alerts/${endpointKey}`,
    secret: row.kind === 'webhook' ? secret : null,
  };
}

type AlertPayload = { fingerprint: string; title: string; severity: 'critical' | 'warning' | 'info'; status: 'firing' | 'resolved'; details?: string; url?: string };

function parsePayload(raw: string): AlertPayload {
  let p: Partial<AlertPayload>;
  try { p = JSON.parse(raw) as Partial<AlertPayload>; } catch { throw unprocessable('Body must be JSON'); }
  const severity = p.severity ?? 'critical';
  const status = p.status ?? 'firing';
  if (!p.fingerprint || !p.title || !['critical', 'warning', 'info'].includes(severity) || !['firing', 'resolved'].includes(status)) {
    throw unprocessable('Expected fingerprint, title, severity (critical|warning|info) and status (firing|resolved)');
  }
  // Only an http(s) link to the source is kept; anything else could be a script URL on the page.
  const url = typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? p.url.slice(0, 500) : undefined;
  return { fingerprint: String(p.fingerprint).slice(0, 200), title: String(p.title).slice(0, 300), severity, status, details: p.details ? String(p.details).slice(0, 10000) : undefined, url };
}

export async function receiveWebhook(endpointKey: string, rawBody: string, signature: string | undefined, timestamp: string | undefined) {
  const integration = await one<IntegrationRow>("SELECT * FROM alert_integrations WHERE endpoint_key = $1 AND kind = 'webhook'", [endpointKey]);
  if (!integration || !integration.is_active || !signature || !timestamp) throw unauthenticated('Invalid signature');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) throw unauthenticated('Invalid signature');
  const expected = hmacSignature(decryptField(integration.secret_encrypted), `${timestamp}.${rawBody}`);
  if (!safeEqual(expected, signature.replace(/^sha256=/, ''))) throw unauthenticated('Invalid signature');
  await pool.query('UPDATE alert_integrations SET last_received_at = NOW(3) WHERE id = $1', [integration.id]);
  return ingest(integration, parsePayload(rawBody));
}

export async function receiveHeartbeat(endpointKey: string) {
  const integration = await one<IntegrationRow>("SELECT * FROM alert_integrations WHERE endpoint_key = $1 AND kind = 'heartbeat'", [endpointKey]);
  if (!integration || !integration.is_active) throw notFound('Unknown heartbeat');
  await pool.query('UPDATE alert_integrations SET last_received_at = NOW(3), heartbeat_missed_at = NULL WHERE id = $1', [integration.id]);
  // A heartbeat arriving after a miss clears the alert it raised.
  if (integration.heartbeat_missed_at) {
    await ingest(integration, { fingerprint: 'heartbeat-missed', title: `${integration.name} heartbeat missed`, severity: 'critical', status: 'resolved' });
  }
  return { ok: true };
}

async function ingest(integration: IntegrationRow, payload: AlertPayload) {
  const open = await one<{ id: string; incident_id: string | null }>(
    "SELECT id, incident_id FROM alerts WHERE integration_id = $1 AND fingerprint = $2 AND status = 'firing'", [integration.id, payload.fingerprint]);

  if (payload.status === 'resolved') {
    if (!open) return { outcome: 'ignored', alertId: null, incidentId: null };
    await pool.query("UPDATE alerts SET status = 'resolved', resolved_at = NOW(3), last_seen_at = NOW(3) WHERE id = $1", [open.id]);
    if (open.incident_id) {
      const stillFiring = await one<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE incident_id = $1 AND status = 'firing'", [open.incident_id]);
      await pool.query("INSERT INTO incident_events (incident_id, company_id, kind, body) VALUES ($1,$2,'alert_resolved',$3)",
        [open.incident_id, integration.company_id, Number(stillFiring?.n ?? 0) === 0 ? `${payload.title} resolved. All alerts on this incident have resolved.` : `${payload.title} resolved`]);
    }
    return { outcome: 'resolved', alertId: open.id, incidentId: open.incident_id };
  }

  if (open) {
    await pool.query('UPDATE alerts SET occurrences = occurrences + 1, last_seen_at = NOW(3), title = $2, details = COALESCE($3, details) WHERE id = $1', [open.id, payload.title, payload.details ?? null]);
    return { outcome: 'repeated', alertId: open.id, incidentId: open.incident_id };
  }

  const suppressed = await inMaintenance(integration.service_id);
  const alertId = newId();
  await pool.query(
    `INSERT INTO alerts (id, company_id, integration_id, service_id, fingerprint, title, severity, details, source_url, suppressed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [alertId, integration.company_id, integration.id, integration.service_id, payload.fingerprint, payload.title, payload.severity, payload.details ?? null, payload.url ?? null, suppressed]);
  if (suppressed) return { outcome: 'suppressed', alertId, incidentId: null };

  const threshold = integration.incident_severity;
  const qualifies = threshold !== null && payload.severity !== 'info' && (threshold === 'warning' || payload.severity === 'critical');
  if (!qualifies) return { outcome: 'recorded', alertId, incidentId: null };

  // Another alert already opened an incident for this service: add to it, do not open a second.
  const existing = await one<{ id: string }>(
    `SELECT i.id FROM incidents i JOIN incident_services x ON x.incident_id = i.id
      WHERE x.service_id = $1 AND i.status <> 'resolved' AND i.source IN ('alert','heartbeat') ORDER BY i.detected_at DESC LIMIT 1`, [integration.service_id]);
  if (existing) {
    await pool.query('UPDATE alerts SET incident_id = $2 WHERE id = $1', [alertId, existing.id]);
    await pool.query("INSERT INTO incident_events (incident_id, company_id, kind, body) VALUES ($1,$2,'alert',$3)", [existing.id, integration.company_id, `${payload.severity}: ${payload.title}`]);
    return { outcome: 'attached', alertId, incidentId: existing.id };
  }

  const { declareIncident } = await import('./incidents.js');
  const systemActor = await automationActor(integration.company_id);
  const incident = await declareIncident(systemActor, {
    title: payload.title,
    severity: payload.severity === 'critical' ? 'sev2' : 'sev3',
    summary: `Opened automatically by the ${integration.name} integration.${payload.details ? `\n\n${payload.details}` : ''}`,
    services: [{ serviceId: integration.service_id, impact: payload.severity === 'critical' ? 'partial_outage' : 'degraded' }],
    commanderId: null,
  }, integration.kind === 'heartbeat' ? 'heartbeat' : 'alert');
  await pool.query('UPDATE alerts SET incident_id = $2 WHERE id = $1', [alertId, incident.id]);
  await pool.query("INSERT INTO incident_events (incident_id, company_id, kind, body) VALUES ($1,$2,'alert',$3)", [incident.id, integration.company_id, `${payload.severity}: ${payload.title}`]);
  logger.info({ incidentId: incident.id, integrationId: integration.id }, 'incident opened from alert');
  return { outcome: 'incident', alertId, incidentId: incident.id };
}

/** An Actor for work the system does on its own. It is scoped to one company and holds no capabilities. */
async function automationActor(companyId: string): Promise<Actor> {
  return {
    userId: '00000000-0000-0000-0000-000000000000', companyId, email: 'automation@system', displayName: 'Automation',
    accessLevel: 'service', status: 'active', departmentId: null, managerId: null, capabilities: new Set(), groupIds: [],
    sessionId: null, tokenId: null, tokenScopes: [],
  };
}

/** Scheduled: raises an alert for every heartbeat whose interval has passed without a call. */
export async function checkHeartbeats(): Promise<number> {
  const late = await many<IntegrationRow>(
    `SELECT * FROM alert_integrations
      WHERE kind = 'heartbeat' AND is_active = 1 AND heartbeat_missed_at IS NULL
        AND COALESCE(last_received_at, created_at) < DATE_SUB(NOW(3), INTERVAL heartbeat_minutes MINUTE)`);
  for (const integration of late) {
    const claim = await pool.query('UPDATE alert_integrations SET heartbeat_missed_at = NOW(3) WHERE id = $1 AND heartbeat_missed_at IS NULL', [integration.id]);
    if (claim.rowCount === 0) continue;
    await ingest(integration, {
      fingerprint: 'heartbeat-missed', title: `${integration.name} heartbeat missed`, severity: 'critical', status: 'firing',
      details: `No heartbeat in the last ${integration.heartbeat_minutes} minutes.`,
    });
  }
  return late.length;
}

export async function listAlerts(actor: Actor, filter: { status?: 'firing' | 'resolved'; serviceId?: string; limit: number }) {
  if (actor.accessLevel === 'guest') throw forbidden();
  await authorize({ actor, capability: 'reliability.read', resourceless: true });
  const where = ['a.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  if (filter.status) { params.push(filter.status); where.push(`a.status = $${params.length}`); }
  if (filter.serviceId) { params.push(filter.serviceId); where.push(`a.service_id = $${params.length}`); }
  params.push(filter.limit);
  const rows = await many<{ id: string; title: string; severity: string; status: string; occurrences: number; first_seen_at: Date; last_seen_at: Date; resolved_at: Date | null; suppressed: number; source_url: string | null; service_id: string; service_name: string; integration_name: string; incident_id: string | null; incident_number: number | null }>(
    `SELECT a.*, s.name AS service_name, x.name AS integration_name, i.number AS incident_number
       FROM alerts a JOIN services s ON s.id = a.service_id JOIN alert_integrations x ON x.id = a.integration_id LEFT JOIN incidents i ON i.id = a.incident_id
      WHERE ${where.join(' AND ')} ORDER BY (a.status = 'resolved'), a.last_seen_at DESC LIMIT $${params.length}`, params);
  return rows.map((a) => ({
    id: a.id, title: a.title, severity: a.severity, status: a.status, occurrences: Number(a.occurrences), firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at,
    resolvedAt: a.resolved_at, suppressed: Boolean(a.suppressed), sourceUrl: a.source_url, serviceId: a.service_id, serviceName: a.service_name,
    integrationName: a.integration_name, incident: a.incident_id ? { id: a.incident_id, ref: `INC-${a.incident_number}` } : null,
  }));
}

/** Only used by tests and the settings screen's instructions. */
export function sign(secret: string, timestamp: string, body: string): string {
  return hmacSignature(secret, `${timestamp}.${body}`);
}

/** Deletes an integration. Its alerts go with it unless one opened an incident, which keeps them as evidence. */
export async function deleteIntegration(actor: Actor, id: string) {
  await authorize({ actor, capability: 'reliability.manage', resourceless: true });
  const row = await one<{ name: string; service_id: string }>('SELECT name, service_id FROM alert_integrations WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!row) throw notFound('Integration not found');
  if (await one('SELECT 1 FROM alerts WHERE integration_id = $1 AND incident_id IS NOT NULL LIMIT 1', [id])) {
    throw conflict('Alerts from this integration are part of an incident. Pause it instead.');
  }
  await pool.query('DELETE FROM alert_integrations WHERE id = $1', [id]);
  await auditFromActor(actor, 'reliability.integration.delete', { resourceType: 'alert_integration', resourceId: id, metadata: { serviceId: row.service_id, name: row.name } });
}
