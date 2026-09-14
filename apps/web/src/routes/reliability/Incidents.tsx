/**
 * Incidents: the list, the incident command view, and the postmortem.
 *
 * The command view is built for the first ten minutes of an outage: acknowledge and
 * status sit at the top, the timeline takes the page, and posting to it is one box with
 * an explicit switch between an internal note and a public status update. Nothing becomes
 * public by accident - public updates are a separate, labelled action only the commander
 * sees, and only after the incident has been marked public.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BellOff, Globe2, Lock, Plus, UserPlus, X } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import {
  durationText, IMPACT_LABEL, INCIDENT_STATUS_LABEL, IncidentStatusBadge, SEVERITY_LABEL, SeverityBadge, ServiceStatusBadge,
  type Impact, type IncidentStatus, type ServiceStatus, type Severity,
} from '../../lib/reliability';
import type { ServiceSummary } from './Overview';
import { DeclareDialog } from './Overview';
import type { TicketSummary } from '../../lib/service';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/reliability.css';

type Incident = {
  id: string; ref: string; title: string; severity: Severity; status: IncidentStatus; summary: string | null; customerImpact: string | null;
  source: string; detectedAt: string; acknowledgedAt: string | null; mitigatedAt: string | null; resolvedAt: string | null;
  isPublic: boolean; publicTitle: string | null; commander: { id: string; name: string } | null;
  escalation: { level: number; round: number; nextAt: string | null } | null;
  services: { id: string; name: string; impact: Impact; status: ServiceStatus }[];
  responders: { id: string; name: string; role: string; pagedAt: string | null; joinedAt: string }[];
  events: { id: number; kind: string; body: string | null; visibility: 'internal' | 'public'; status: IncidentStatus | null; createdAt: string; actorName: string | null }[];
  alerts: { id: string; title: string; severity: string; status: string; occurrences: number; firstSeenAt: string; lastSeenAt: string; sourceUrl: string | null }[];
  tickets: { id: string; ref: string; subject: string; status: string; type: string }[];
  problem: { id: string; ref: string; subject: string; status: string } | null;
  postmortemStatus: string | null; version: number;
  recentDeployments: { id: string; service: { id: string; name: string }; environment: string; version: string | null; commitSha: string | null; status: string; startedAt: string }[];
  permissions: { isResponder: boolean; canJoin: boolean; canUpdate: boolean; canLead: boolean; canAcknowledge: boolean };
};

const EVENT_TEXT: Record<string, string> = {
  declared: 'declared the incident', paged: '', acknowledged: 'acknowledged', status: 'changed status', severity: 'changed severity',
  note: 'posted an internal note', public_update: 'published a status update', joined: 'joined', responder_added: 'brought in a responder',
  commander: 'changed the commander', made_public: 'made the incident public', made_internal: 'made the incident internal',
  services: 'changed affected services', alert: 'Alert', alert_resolved: 'Alert resolved', ticket_linked: 'linked a ticket',
  ticket_unlinked: 'unlinked a ticket', problem_opened: 'opened a problem ticket', escalation_exhausted: 'Escalation exhausted',
  postmortem_published: 'published the postmortem',
};

export default function IncidentList() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [declaring, setDeclaring] = useState(false);
  const key = `/reliability/incidents?status=${status}&limit=100`;
  const list = useQuery<{ items: { id: string; ref: string; title: string; severity: Severity; status: IncidentStatus; services: string; commanderName: string | null; detectedAt: string; acknowledgedAt: string | null; resolvedAt: string | null; source: string; isPublic: boolean }[] }>(key, (s) => api.get(key, s));
  const services = useQuery<{ items: ServiceSummary[] }>(declaring ? '/reliability/services' : null, (s) => api.get('/reliability/services', s));

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Reliability</p><h2>Incidents</h2></div>
        <div className="cc-header-side">{can('incident.declare') ? <button type="button" className="primary-button" onClick={() => setDeclaring(true)}><Plus size={15} aria-hidden="true" /> Declare incident</button> : null}</div>
      </header>
      <div className="tab-row" role="tablist" aria-label="Incident views">
        {([['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={status === id} className={`tab ${status === id ? 'tab-active' : ''}`} onClick={() => setStatus(id)}>{label}</button>
        ))}
      </div>
      {list.loading && !list.data ? <Loading label="Loading incidents" rows={5} />
        : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title={status === 'open' ? 'No open incidents' : 'No incidents'} description={status === 'open' ? 'Everything is running. Incidents declared by people or opened by alerts appear here.' : 'Nothing in this view.'} />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Incident</th><th scope="col">Severity</th><th scope="col">Status</th><th scope="col">Services</th><th scope="col">Commander</th><th scope="col">Duration</th></tr></thead>
              <tbody>
                {list.data!.items.map((i) => (
                  <tr key={i.id} className="sd-row" onClick={() => navigate(`/reliability/incidents/${i.id}`)}>
                    <th scope="row">
                      <Link to={`/reliability/incidents/${i.id}`} className="sd-subject" onClick={(e) => e.stopPropagation()}><span className="sd-ref">{i.ref}</span><span>{i.title}</span></Link>
                      <span className="sd-sub">{i.source === 'manual' ? 'Declared' : i.source === 'heartbeat' ? 'Missed heartbeat' : 'From alert'} · {formatDateTime(i.detectedAt)}{i.isPublic ? ' · public' : ''}</span>
                    </th>
                    <td><SeverityBadge severity={i.severity} /></td>
                    <td><IncidentStatusBadge status={i.status} />{!i.acknowledgedAt && i.status !== 'resolved' ? <span className="sd-sub sd-target-breached">Unacknowledged</span> : null}</td>
                    <td>{i.services}</td>
                    <td>{i.commanderName ?? <span className="sd-muted">None</span>}</td>
                    <td className="rl-clock">{durationText(i.detectedAt, i.resolvedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {declaring && services.data ? <DeclareDialog services={services.data.items.filter((s) => s.isActive)} onClose={() => setDeclaring(false)} onDeclared={(id) => { setDeclaring(false); invalidate('/reliability'); navigate(`/reliability/incidents/${id}`); }} /> : null}
    </div>
  );
}

export function IncidentDetail() {
  const { incidentId } = useParams();
  const key = `/reliability/incidents/${incidentId}`;
  const incident = useQuery<Incident>(incidentId ? key : null, (s) => api.get(key, s));
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 30_000); return () => window.clearInterval(t); }, []);

  if (incident.loading && !incident.data) return <Loading label="Loading incident" rows={6} />;
  if (incident.error && !incident.data) {
    return incident.error instanceof ApiError && incident.error.status === 404
      ? <Empty title="Incident not found" action={<Link className="ghost-button" to="/reliability/incidents">All incidents</Link>} />
      : <ErrorState error={incident.error} onRetry={incident.reload} />;
  }
  const i = incident.data!;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not go through.'); }
    invalidate(key); invalidate('/reliability/');
  };
  const patch = (body: Record<string, unknown>) => act(() => api.patch(`/reliability/incidents/${i.id}`, body, { ifMatch: i.version }));

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to="/reliability/incidents" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Incidents</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">{i.ref} · {i.source === 'manual' ? 'Declared' : i.source === 'heartbeat' ? 'Missed heartbeat' : 'Opened by alert'}</p>
          <h2>{i.title}</h2>
          <div className="rl-head-meta">
            <SeverityBadge severity={i.severity} />
            <IncidentStatusBadge status={i.status} />
            <span className="rl-clock">{i.status === 'resolved' ? `Lasted ${durationText(i.detectedAt, i.resolvedAt)}` : `Open ${durationText(i.detectedAt)}`}</span>
            {i.acknowledgedAt ? <span>Acknowledged {relativeTime(i.acknowledgedAt)}</span> : i.status !== 'resolved' ? <span className="sd-target-breached">Not acknowledged{i.escalation?.nextAt ? ` · escalates ${relativeTime(i.escalation.nextAt)}` : ''}</span> : null}
            {i.isPublic ? <span className="rl-public-tag"><Globe2 size={11} aria-hidden="true" /> Public</span> : null}
          </div>
        </div>
        <div className="cc-header-side">
          {i.permissions.canAcknowledge ? <button type="button" className="primary-button" onClick={() => void act(() => api.post(`/reliability/incidents/${i.id}/acknowledge`, {}))}><BellOff size={15} aria-hidden="true" /> Acknowledge</button> : null}
          {i.permissions.canJoin ? <button type="button" className="primary-button" onClick={() => void act(() => api.post(`/reliability/incidents/${i.id}/join`, {}))}><UserPlus size={15} aria-hidden="true" /> Join as responder</button> : null}
          {i.permissions.canUpdate ? (
            <select aria-label="Incident status" value={i.status} onChange={(e) => void patch({ status: e.target.value })}>
              {(Object.keys(INCIDENT_STATUS_LABEL) as IncidentStatus[]).map((s) => <option key={s} value={s}>{INCIDENT_STATUS_LABEL[s]}</option>)}
            </select>
          ) : null}
          {i.status === 'resolved' ? <Link className="ghost-button" to={`/reliability/incidents/${i.id}/postmortem`}>{i.postmortemStatus === 'published' ? 'Postmortem' : 'Write postmortem'}</Link> : null}
        </div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      <div className="rl-command">
        <div className="sd-main">
          <section className="cc-panel" aria-label="Timeline">
            <header><h3>Timeline</h3><span className="cc-meta">{i.events.length} entries</span></header>
            {i.permissions.canUpdate && i.status !== 'resolved' ? <Composer incident={i} onDone={() => { invalidate(key); }} onError={setError} /> : null}
            <ol className="rl-timeline">
              {[...i.events].reverse().map((e) => (
                <li key={e.id}>
                  <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>{new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  <span className={`rl-dot rl-dot-${e.kind}`} aria-hidden="true" />
                  <div>
                    <div className="rl-event-head">
                      {e.actorName ? <strong>{e.actorName} </strong> : null}
                      {e.kind === 'paged' ? '' : EVENT_TEXT[e.kind] ?? e.kind}
                      {e.status ? ` · ${INCIDENT_STATUS_LABEL[e.status]}` : ''}
                      {e.visibility === 'public' ? <span className="rl-public-tag"><Globe2 size={11} aria-hidden="true" /> Public</span> : null}
                    </div>
                    {e.body ? <p className="sd-body">{e.body}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {i.alerts.length > 0 ? (
            <section className="cc-panel" aria-label="Alerts">
              <header><h3>Alerts</h3></header>
              <ul className="cc-rows">
                {i.alerts.map((a) => (
                  <li key={a.id} className="cc-row">
                    <span className="cc-row-main"><strong>{a.title}</strong><span>{a.severity} · {a.occurrences} {a.occurrences === 1 ? 'time' : 'times'} · last {relativeTime(a.lastSeenAt)}</span></span>
                    {a.sourceUrl ? <a className="sd-link-button" href={a.sourceUrl} target="_blank" rel="noreferrer noopener">Source</a> : null}
                    <span className={`cc-tag ${a.status === 'firing' ? 'cc-tag-critical' : ''}`}>{a.status === 'firing' ? 'Firing' : 'Resolved'}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {i.recentDeployments.length > 0 ? (
            <section className="cc-panel" aria-label="Recent deployments">
              <header><h3>Deployments in the day before</h3></header>
              <ul className="cc-rows">
                {i.recentDeployments.map((d) => (
                  <li key={d.id}>
                    <Link to={`/engineering/services/${d.service.id}`} className="cc-row">
                      <span className="cc-row-main">
                        <strong>{d.service.name} · {d.version ?? d.commitSha?.slice(0, 7) ?? 'Unversioned'} → {d.environment}</strong>
                        <span>{new Date(d.startedAt) > new Date(i.detectedAt) ? `${durationText(i.detectedAt, d.startedAt)} after detection` : `${durationText(d.startedAt, i.detectedAt)} before detection`}</span>
                      </span>
                      <span className={`cc-tag ${d.status === 'failed' || d.status === 'rolled_back' ? 'cc-tag-critical' : ''}`}>{d.status.replace('_', ' ')}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="sd-side">
          {i.permissions.canLead ? <LeadPanel incident={i} onPatch={patch} /> : (
            <section className="cc-panel" aria-label="Summary">
              <header><h3>Summary</h3></header>
              <dl className="sd-props">
                <dt>Commander</dt><dd>{i.commander?.name ?? 'None'}</dd>
                <dt>Detected</dt><dd>{formatDateTime(i.detectedAt)}</dd>
                {i.mitigatedAt ? <><dt>Mitigated</dt><dd>{formatDateTime(i.mitigatedAt)}</dd></> : null}
                {i.resolvedAt ? <><dt>Resolved</dt><dd>{formatDateTime(i.resolvedAt)}</dd></> : null}
              </dl>
              {i.summary ? <p className="sd-panel-pad sd-body">{i.summary}</p> : null}
            </section>
          )}

          <section className="cc-panel" aria-label="Affected services">
            <header><h3>Affected services</h3></header>
            <ul className="cc-rows">
              {i.services.map((s) => (
                <li key={s.id}><Link to={`/reliability/services/${s.id}`} className="cc-row"><span className="cc-row-main"><strong>{s.name}</strong><span>Impact: {IMPACT_LABEL[s.impact]}</span></span><ServiceStatusBadge status={s.status} /></Link></li>
              ))}
            </ul>
          </section>

          <Responders incident={i} onAct={act} />
          <TicketsPanel incident={i} onAct={act} />
        </aside>
      </div>
    </div>
  );
}

function Composer({ incident, onDone, onError }: { incident: Incident; onDone: () => void; onError: (m: string | null) => void }) {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'internal' | 'public'>('internal');
  const [status, setStatus] = useState<IncidentStatus | ''>('');
  const [pending, setPending] = useState(false);
  const canPublic = incident.permissions.canLead;
  return (
    <form className={`rl-composer ${visibility === 'public' ? 'is-public' : ''}`} onSubmit={async (e) => {
      e.preventDefault(); if (!body.trim()) return; setPending(true); onError(null);
      try { await api.post(`/reliability/incidents/${incident.id}/updates`, { body, visibility, status: status || undefined }); setBody(''); setStatus(''); onDone(); }
      catch (err) { onError(err instanceof ApiError ? err.message : 'The update was not posted.'); }
      finally { setPending(false); }
    }}>
      {canPublic ? (
        <div className="tab-row" role="tablist" aria-label="Update type">
          <button type="button" role="tab" aria-selected={visibility === 'internal'} className={`tab ${visibility === 'internal' ? 'tab-active' : ''}`} onClick={() => setVisibility('internal')}><Lock size={12} aria-hidden="true" /> Internal note</button>
          <button type="button" role="tab" aria-selected={visibility === 'public'} className={`tab ${visibility === 'public' ? 'tab-active' : ''}`} onClick={() => setVisibility('public')} disabled={!incident.isPublic} title={incident.isPublic ? '' : 'Make the incident public first'}><Globe2 size={12} aria-hidden="true" /> Public status update</button>
        </div>
      ) : null}
      <label className="visually-hidden" htmlFor="rl-update">Update</label>
      <textarea id="rl-update" value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000}
        placeholder={visibility === 'public' ? 'Shown on the public status page. Plain language, no internal detail.' : 'What you found, what you tried, what is next'} />
      <div className="sd-inline">
        <select aria-label="Also change status to" value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus | '')}>
          <option value="">Keep status ({INCIDENT_STATUS_LABEL[incident.status]})</option>
          {(Object.keys(INCIDENT_STATUS_LABEL) as IncidentStatus[]).filter((s) => s !== incident.status).map((s) => <option key={s} value={s}>Set to {INCIDENT_STATUS_LABEL[s]}</option>)}
        </select>
        <button type="submit" className="primary-button" disabled={pending || !body.trim()}>{visibility === 'public' ? 'Publish update' : 'Post note'}</button>
      </div>
    </form>
  );
}

function LeadPanel({ incident, onPatch }: { incident: Incident; onPatch: (b: Record<string, unknown>) => Promise<void> }) {
  const people = useQuery<Paged<{ id: string; displayName: string }>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const [publicTitle, setPublicTitle] = useState(incident.publicTitle ?? '');
  const [summary, setSummary] = useState(incident.summary ?? '');
  return (
    <section className="cc-panel" aria-label="Command">
      <header><h3>Command</h3></header>
      <div className="sd-fields">
        <label className="field"><span>Severity</span>
          <select value={incident.severity} onChange={(e) => void onPatch({ severity: e.target.value })}>
            {(Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="field"><span>Commander</span>
          <select value={incident.commander?.id ?? ''} onChange={(e) => void onPatch({ commanderId: e.target.value || null })} disabled={!people.data}>
            <option value="">None</option>
            {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </label>
        <label className="field"><span>Summary</span>
          <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} onBlur={() => { if (summary !== (incident.summary ?? '')) void onPatch({ summary: summary || null }); }} />
        </label>
        <label className="sd-check"><input type="checkbox" checked={incident.isPublic} onChange={(e) => void onPatch({ isPublic: e.target.checked, publicTitle: publicTitle || null })} /> Show on the public status page</label>
        {incident.isPublic ? (
          <label className="field"><span>Public title</span>
            <input value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)} onBlur={() => { if (publicTitle !== (incident.publicTitle ?? '')) void onPatch({ publicTitle: publicTitle || null }); }} placeholder={incident.title} maxLength={300} />
          </label>
        ) : null}
      </div>
    </section>
  );
}

function Responders({ incident, onAct }: { incident: Incident; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const people = useQuery<Paged<{ id: string; displayName: string }>>(incident.permissions.canLead ? '/users?limit=100' : null, (s) => api.get('/users?limit=100', s));
  const [choice, setChoice] = useState('');
  return (
    <section className="cc-panel" aria-label="Responders">
      <header><h3>Responders</h3><span className="cc-meta">{incident.responders.length}</span></header>
      <ul className="cc-rows">
        {incident.responders.map((r) => (
          <li key={r.id} className="cc-row"><span className="cc-row-main"><strong>{r.name}</strong><span>{r.role.replace('_', ' ')}{r.pagedAt ? ` · paged ${relativeTime(r.pagedAt)}` : ''}</span></span></li>
        ))}
      </ul>
      {incident.permissions.canLead && incident.status !== 'resolved' ? (
        <div className="sd-panel-pad sd-inline">
          <select aria-label="Bring in" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Bring someone in…</option>
            {people.data?.items.filter((p) => !incident.responders.some((r) => r.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
          <button type="button" className="ghost-button" disabled={!choice} onClick={() => void onAct(async () => { await api.post(`/reliability/incidents/${incident.id}/responders`, { userId: choice }); setChoice(''); })}>Page</button>
        </div>
      ) : null}
    </section>
  );
}

function TicketsPanel({ incident, onAct }: { incident: Incident; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [linking, setLinking] = useState('');
  const { can } = useSession();
  const tickets = useQuery<Paged<TicketSummary>>(incident.permissions.canUpdate && can('ticket.create') ? '/service/tickets?limit=100&status=active' : null, (s) => api.get('/service/tickets?limit=100&status=active', s));
  return (
    <section className="cc-panel" aria-label="Service desk">
      <header><h3>Service desk</h3></header>
      <dl className="sd-props">
        <dt>Problem</dt>
        <dd>{incident.problem ? <Link to={`/service/tickets/${incident.problem.id}`}>{incident.problem.ref} {incident.problem.subject}</Link>
          : incident.permissions.canLead ? <button type="button" className="sd-link-button" onClick={() => void onAct(() => api.post(`/reliability/incidents/${incident.id}/problem`, {}))}>Open problem ticket</button> : 'None'}</dd>
      </dl>
      {incident.tickets.filter((t) => t.id !== incident.problem?.id).length > 0 ? (
        <ul className="cc-rows">
          {incident.tickets.filter((t) => t.id !== incident.problem?.id).map((t) => (
            <li key={t.id} className="sd-link-row">
              <Link to={`/service/tickets/${t.id}`} className="cc-row"><span className="sd-ref">{t.ref}</span><span className="cc-row-main"><strong>{t.subject}</strong></span></Link>
              {incident.permissions.canUpdate ? <button type="button" className="icon-button" aria-label={`Unlink ${t.ref}`} onClick={() => void onAct(() => api.delete(`/reliability/incidents/${incident.id}/tickets/${t.id}`))}><X size={14} /></button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {tickets.data ? (
        <div className="sd-panel-pad sd-inline">
          <select aria-label="Link a ticket" value={linking} onChange={(e) => setLinking(e.target.value)}>
            <option value="">Link a related ticket…</option>
            {tickets.data.items.filter((t) => !incident.tickets.some((l) => l.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.ref} · {t.subject}</option>)}
          </select>
          <button type="button" className="ghost-button" disabled={!linking} onClick={() => void onAct(async () => { await api.post(`/reliability/incidents/${incident.id}/tickets`, { ticketId: linking }); setLinking(''); })}>Link</button>
        </div>
      ) : null}
    </section>
  );
}

type Postmortem = {
  incident: { id: string; ref: string; title: string; severity: Severity; status: IncidentStatus; detectedAt: string; acknowledgedAt: string | null; mitigatedAt: string | null; resolvedAt: string | null };
  postmortem: { summary: string | null; impact: string | null; rootCause: string | null; wentWell: string | null; wentWrong: string | null; lessons: string | null; status: string; authorName: string | null; publishedAt: string | null } | null;
  actions: { id: string; title: string; ownerName: string | null; taskId: string | null; taskStatus: string | null; taskRef: string | null }[];
  timeline: { kind: string; body: string | null; createdAt: string; actorName: string | null }[];
  canEdit: boolean; canPublish: boolean;
};

const PM_FIELDS: [keyof NonNullable<Postmortem['postmortem']>, string, string][] = [
  ['summary', 'Summary', 'What happened, in two or three sentences'],
  ['impact', 'Impact', 'Who was affected, how badly, for how long'],
  ['rootCause', 'Root cause', 'The underlying cause, not the trigger'],
  ['wentWell', 'What went well', ''],
  ['wentWrong', 'What went wrong', ''],
  ['lessons', 'Lessons', ''],
];

export function PostmortemPage() {
  const { incidentId } = useParams();
  const key = `/reliability/incidents/${incidentId}/postmortem`;
  const data = useQuery<Postmortem>(incidentId ? key : null, (s) => api.get(key, s));
  const projects = useQuery<{ items: { id: string; key: string; name: string }[] }>('/projects', (s) => api.get('/projects', s));
  const people = useQuery<Paged<{ id: string; displayName: string }>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [action, setAction] = useState({ title: '', projectId: '', ownerId: '' });
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (data.loading && !data.data) return <Loading label="Loading postmortem" rows={6} />;
  if (data.error && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />;
  const d = data.data!;
  const values: Record<string, string> = draft ?? Object.fromEntries(PM_FIELDS.map(([k]) => [k, (d.postmortem?.[k] as string | null) ?? '']));
  const resolved = d.incident.status === 'resolved';
  const save = async (publish: boolean) => {
    setMessage(null);
    try {
      const body = Object.fromEntries(PM_FIELDS.map(([k]) => [k, values[k] || null]));
      if (publish) await api.post(`/reliability/incidents/${d.incident.id}/postmortem/publish`, body);
      else await api.put(`/reliability/incidents/${d.incident.id}/postmortem`, body);
      setDraft(null);
      setMessage({ kind: 'ok', text: publish ? 'Postmortem published.' : 'Draft saved.' });
    } catch (err) { setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'The postmortem was not saved.' }); }
    invalidate(key);
  };

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to={`/reliability/incidents/${d.incident.id}`} className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> {d.incident.ref}</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">Postmortem · {d.postmortem?.status === 'published' ? `published ${d.postmortem.publishedAt ? relativeTime(d.postmortem.publishedAt) : ''}` : 'draft'}</p>
          <h2>{d.incident.title}</h2>
          <div className="rl-head-meta">
            <SeverityBadge severity={d.incident.severity} />
            <span>Detected {formatDateTime(d.incident.detectedAt)}</span>
            {d.incident.acknowledgedAt ? <span>· acknowledged after {durationText(d.incident.detectedAt, d.incident.acknowledgedAt)}</span> : null}
            {d.incident.resolvedAt ? <span>· resolved after {durationText(d.incident.detectedAt, d.incident.resolvedAt)}</span> : null}
          </div>
        </div>
        {d.canEdit && resolved ? (
          <div className="cc-header-side">
            <button type="button" className="ghost-button" onClick={() => void save(false)}>Save draft</button>
            {d.canPublish ? <button type="button" className="primary-button" onClick={() => void save(true)}>Publish</button> : null}
          </div>
        ) : null}
      </header>
      {!resolved ? <p className="field-hint">The postmortem opens once the incident is resolved.</p> : null}
      {message ? <p className={message.kind === 'ok' ? 'field-hint sd-ok' : 'field-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}

      <div className="rl-command">
        <section className="cc-panel sd-panel-pad sd-editor" aria-label="Write-up">
          {PM_FIELDS.map(([k, label, hint]) => (
            <label key={k} className="field">
              <span>{label}{k === 'rootCause' ? ' *' : ''}</span>
              {d.canEdit && resolved ? (
                <textarea rows={k === 'summary' || k === 'rootCause' ? 4 : 3} value={values[k]} placeholder={hint} onChange={(e) => setDraft({ ...values, [k]: e.target.value })} maxLength={20000} />
              ) : <p className="sd-body">{values[k] || <span className="sd-muted">Not written</span>}</p>}
            </label>
          ))}
        </section>
        <aside className="sd-side">
          <section className="cc-panel" aria-label="Action items">
            <header><h3>Action items</h3></header>
            {d.actions.length === 0 ? <p className="cc-empty">No follow-up tasks yet.</p> : (
              <ul className="cc-rows">
                {d.actions.map((a) => (
                  <li key={a.id}>{a.taskId ? <Link to={`/tasks/${a.taskId}`} className="cc-row"><span className="sd-ref">{a.taskRef}</span><span className="cc-row-main"><strong>{a.title}</strong><span>{a.ownerName ?? 'Unassigned'} · {a.taskStatus?.replace('_', ' ')}</span></span></Link> : <span className="cc-row">{a.title}</span>}</li>
                ))}
              </ul>
            )}
            {d.canEdit && resolved ? (
              <form className="sd-panel-pad sd-fields" onSubmit={async (e) => {
                e.preventDefault(); setMessage(null);
                try { await api.post(`/reliability/incidents/${d.incident.id}/postmortem/actions`, { title: action.title, projectId: action.projectId, ownerId: action.ownerId || null }); setAction({ title: '', projectId: action.projectId, ownerId: '' }); }
                catch (err) { setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'The action was not added.' }); }
                invalidate(key);
              }}>
                <label className="field"><span>Action</span><input value={action.title} onChange={(e) => setAction({ ...action, title: e.target.value })} minLength={3} maxLength={300} required placeholder="Alert 30 days before certificates expire" /></label>
                <label className="field"><span>Project</span><select value={action.projectId} onChange={(e) => setAction({ ...action, projectId: e.target.value })} required><option value="">Choose a project</option>{projects.data?.items.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</select></label>
                <label className="field"><span>Owner</span><select value={action.ownerId} onChange={(e) => setAction({ ...action, ownerId: e.target.value })}><option value="">Unassigned</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
                <button type="submit" className="ghost-button">Create task</button>
              </form>
            ) : null}
          </section>
          <section className="cc-panel" aria-label="Incident timeline">
            <header><h3>Timeline</h3></header>
            <ol className="rl-timeline">
              {d.timeline.map((t, n) => (
                <li key={n}><time dateTime={t.createdAt}>{new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span className={`rl-dot rl-dot-${t.kind}`} aria-hidden="true" /><div><div className="rl-event-head">{t.actorName ? <strong>{t.actorName} </strong> : null}{EVENT_TEXT[t.kind] ?? t.kind}</div>{t.body ? <p className="sd-body">{t.body}</p> : null}</div></li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
