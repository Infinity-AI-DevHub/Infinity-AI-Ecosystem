/**
 * Reliability vocabulary shared by the internal pages and the public status page. A
 * service status and an incident severity look the same everywhere they appear.
 */
import { AlertOctagon, AlertTriangle, CheckCircle2, Wrench, Activity } from 'lucide-react';

export type ServiceStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type Impact = 'degraded' | 'partial_outage' | 'major_outage';

export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  operational: 'Operational', degraded: 'Degraded performance', partial_outage: 'Partial outage', major_outage: 'Major outage', maintenance: 'Under maintenance',
};
export const IMPACT_LABEL: Record<Impact, string> = { degraded: 'Degraded', partial_outage: 'Partial outage', major_outage: 'Major outage' };
export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
export const SEVERITY_LABEL: Record<Severity, string> = { sev1: 'SEV1 · Critical', sev2: 'SEV2 · Major', sev3: 'SEV3 · Minor', sev4: 'SEV4 · Low' };

export function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  const Icon = status === 'operational' ? CheckCircle2 : status === 'maintenance' ? Wrench : status === 'degraded' ? Activity : status === 'partial_outage' ? AlertTriangle : AlertOctagon;
  return <span className={`rl-status rl-status-${status}`}><Icon size={13} aria-hidden="true" />{SERVICE_STATUS_LABEL[status]}</span>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`rl-sev rl-sev-${severity}`}>{severity.toUpperCase()}</span>;
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`sd-badge rl-inc-${status}`}>{INCIDENT_STATUS_LABEL[status]}</span>;
}

export function formatAvailability(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  // Only a clean period reads 100%: rounding a short outage up would hide it.
  if (value >= 100) return '100%';
  return `${Math.min(value, 99.999).toFixed(value >= 99 ? 3 : 2)}%`;
}

export function durationText(fromIso: string, toIso?: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
