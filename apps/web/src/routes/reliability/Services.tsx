/**
 * Services: the catalogue, each service's health history, and the integrations that feed
 * it alerts. Secrets are shown once, at creation or rotation, and never again.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Plus } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { durationText, formatAvailability, IncidentStatusBadge, SeverityBadge, SERVICE_STATUS_LABEL, ServiceStatusBadge, type IncidentStatus, type ServiceStatus, type Severity } from '../../lib/reliability';
import type { ServiceSummary } from './Overview';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/reliability.css';

type ServiceDetail = ServiceSummary & {
  description: string | null; ownerUserId: string | null; supportQueueId: string | null; escalationPolicyId: string | null; publicName: string | null;
  availability90d: number; onCall: { id: string; display_name: string }[];
  history: { status: ServiceStatus; startedAt: string; endedAt: string | null; incidentId: string | null }[];
  incidents: { id: string; ref: string; title: string; severity: Severity; status: IncidentStatus; detectedAt: string; resolvedAt: string | null }[];
  integrations: { id: string; name: string; kind: 'webhook' | 'heartbeat'; isActive: boolean; lastReceivedAt: string | null; heartbeatMinutes: number | null; heartbeatMissedAt: string | null; secretFingerprint: string; incidentSeverity: string | null; endpoint: string }[];
};

export default function ServiceList() {
  const { can } = useSession();
  const navigate = useNavigate();
  const list = useQuery<{ items: ServiceSummary[] }>('/reliability/services?includeInactive=true', (s) => api.get('/reliability/services?includeInactive=true', s));
  const [creating, setCreating] = useState(false);
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Reliability</p><h2>Services</h2></div>
        <div className="cc-header-side">{can('reliability.manage') ? <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> Add service</button> : null}</div>
      </header>
      {list.loading && !list.data ? <Loading label="Loading services" rows={5} />
        : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No services yet" description="Add the websites, APIs and internal systems whose health you want to track." />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Service</th><th scope="col">Status</th><th scope="col">30-day availability</th><th scope="col">Owner</th><th scope="col">Escalation</th><th scope="col">Visibility</th></tr></thead>
              <tbody>
                {list.data!.items.map((s) => (
                  <tr key={s.id} className="sd-row" onClick={() => navigate(`/reliability/services/${s.id}`)}>
                    <th scope="row"><Link to={`/reliability/services/${s.id}`} className="sd-subject" onClick={(e) => e.stopPropagation()}><span>{s.name}</span></Link><span className="sd-sub">{s.tier} tier{!s.isActive ? ' · retired' : ''}</span></th>
                    <td><ServiceStatusBadge status={s.status} /></td>
                    <td className="rl-uptime">{formatAvailability(s.availability30d)}</td>
                    <td>{s.ownerName ?? <span className="sd-muted">—</span>}</td>
                    <td>{s.escalationPolicyName ?? <span className="sd-muted">Nobody is paged</span>}</td>
                    <td>{s.isPublic ? 'Public' : 'Internal'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {creating ? <ServiceDialog onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); invalidate('/reliability/services'); navigate(`/reliability/services/${id}`); }} /> : null}
    </div>
  );
}

function ServiceDialog({ service, onClose, onSaved }: { service?: ServiceDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const people = useQuery<Paged<{ id: string; displayName: string }>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const queues = useQuery<{ items: { id: string; name: string }[] }>('/service/queues', (s) => api.get('/service/queues', s));
  const policies = useQuery<{ items: { id: string; name: string }[] }>('/reliability/escalation-policies', (s) => api.get('/reliability/escalation-policies', s));
  const [f, setF] = useState({
    name: service?.name ?? '', description: service?.description ?? '', tier: service?.tier ?? 'standard', ownerUserId: service?.ownerUserId ?? '',
    supportQueueId: service?.supportQueueId ?? '', escalationPolicyId: service?.escalationPolicyId ?? '', isPublic: service?.isPublic ?? false,
    publicName: service?.publicName ?? '', isActive: service?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="svc-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { ...f, description: f.description || null, ownerUserId: f.ownerUserId || null, supportQueueId: f.supportQueueId || null, escalationPolicyId: f.escalationPolicyId || null, publicName: f.publicName || null };
          try {
            const saved = service ? await api.put<{ id: string }>(`/reliability/services/${service.id}`, body) : await api.post<{ id: string }>('/reliability/services', body);
            onSaved(saved.id);
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The service was not saved.'); }
        }}>
        <h3 id="svc-title">{service ? 'Edit service' : 'Add service'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Name</span><input autoFocus value={f.name} onChange={set('name')} required minLength={2} maxLength={160} placeholder="Customer portal" /></label>
          <label className="field sd-span-2"><span>Description</span><textarea rows={2} value={f.description} onChange={set('description')} maxLength={5000} /></label>
          <label className="field"><span>Tier</span><select value={f.tier} onChange={set('tier')}><option value="critical">Critical</option><option value="high">High</option><option value="standard">Standard</option></select></label>
          <label className="field"><span>Owner</span><select value={f.ownerUserId} onChange={set('ownerUserId')}><option value="">None</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field"><span>Escalation policy</span><select value={f.escalationPolicyId} onChange={set('escalationPolicyId')}><option value="">None - nobody is paged</option>{policies.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field"><span>Support queue</span><select value={f.supportQueueId} onChange={set('supportQueueId')}><option value="">None</option>{queues.data?.items.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select></label>
          <label className="sd-check"><input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} /> Show on the public status page</label>
          {f.isPublic ? <label className="field"><span>Public name</span><input value={f.publicName} onChange={set('publicName')} maxLength={160} placeholder={f.name} /></label> : null}
          {service ? <label className="sd-check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label> : null}
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save</button></div>
      </form>
    </div>
  );
}

export function ServiceDetailPage() {
  const { serviceId } = useParams();
  const { can } = useSession();
  const key = `/reliability/services/${serviceId}`;
  const svc = useQuery<ServiceDetail>(serviceId ? key : null, (s) => api.get(key, s));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<{ endpoint: string; secret: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (svc.loading && !svc.data) return <Loading label="Loading service" rows={6} />;
  if (svc.error && !svc.data) return svc.error instanceof ApiError && svc.error.status === 404 ? <Empty title="Service not found" /> : <ErrorState error={svc.error} onRetry={svc.reload} />;
  const s = svc.data!;
  const manage = can('reliability.manage');
  const integrationAct = async (id: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      const res = await api.patch<{ endpoint: string; secret: string | null }>(`/reliability/integrations/${id}`, body);
      if (body.rotate) setRevealed(res);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not go through.'); }
    invalidate(key);
  };

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to="/reliability/services" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Services</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">{s.tier} tier · {s.isPublic ? 'public' : 'internal'}{s.isActive ? '' : ' · retired'}</p>
          <h2>{s.name}</h2>
          <div className="rl-head-meta"><ServiceStatusBadge status={s.status} />{s.history.find((h) => !h.endedAt) ? <span>since {relativeTime(s.history.find((h) => !h.endedAt)!.startedAt)}</span> : null}</div>
        </div>
        <div className="cc-header-side"><Link className="ghost-button" to={`/engineering/services/${s.id}`}>Catalogue entry</Link>{manage ? <button type="button" className="ghost-button" onClick={() => setEditing(true)}>Edit</button> : null}{manage ? <button type="button" className="ghost-button" onClick={async () => {
          if (!window.confirm(`Delete ${s.name}? A service with incident or deployment history can only be retired.`)) return;
          setError(null);
          try { await api.delete(`/reliability/services/${s.id}`); invalidate('/reliability/'); invalidate('/engineering/'); navigate('/reliability/services'); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'The service was not deleted.'); }
        }}>Delete</button> : null}</div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      <section className="cc-panel" aria-label="Health">
        <dl className="cc-stats">
          <div><dt>30-day availability</dt><dd>{formatAvailability(s.availability30d)}</dd></div>
          <div><dt>90-day availability</dt><dd>{formatAvailability(s.availability90d)}</dd></div>
          <div className={s.openIncidents ? 'is-critical' : ''}><dt>Open incidents</dt><dd>{s.openIncidents}</dd></div>
          <div><dt>On call now</dt><dd className="rl-oncall-dd">{s.onCall.length ? s.onCall.map((o) => o.display_name).join(', ') : '—'}</dd></div>
        </dl>
      </section>

      <div className="rl-command">
        <div className="sd-main">
          <section className="cc-panel" aria-label="Incidents">
            <header><h3>Incidents</h3></header>
            {s.incidents.length === 0 ? <p className="cc-empty">No incidents recorded.</p> : (
              <ul className="cc-rows">{s.incidents.map((i) => (
                <li key={i.id}><Link to={`/reliability/incidents/${i.id}`} className="cc-row"><SeverityBadge severity={i.severity} /><span className="cc-row-main"><strong>{i.ref} · {i.title}</strong><span>{formatDateTime(i.detectedAt)} · {durationText(i.detectedAt, i.resolvedAt)}</span></span><IncidentStatusBadge status={i.status} /></Link></li>
              ))}</ul>
            )}
          </section>
          <section className="cc-panel" aria-label="Status history">
            <header><h3>Status history</h3></header>
            <ul className="cc-rows">{s.history.map((h, n) => (
              <li key={n} className="cc-row"><ServiceStatusBadge status={h.status} /><span className="cc-row-main"><span>{formatDateTime(h.startedAt)} – {h.endedAt ? formatDateTime(h.endedAt) : 'now'} · {durationText(h.startedAt, h.endedAt)}</span></span>{h.incidentId ? <Link className="sd-link-button" to={`/reliability/incidents/${h.incidentId}`}>Incident</Link> : null}</li>
            ))}</ul>
          </section>
        </div>
        <aside className="sd-side">
          <section className="cc-panel" aria-label="Ownership">
            <header><h3>Ownership</h3></header>
            <dl className="sd-props">
              <dt>Owner</dt><dd>{s.ownerName ?? '—'}</dd>
              <dt>Escalation</dt><dd>{s.escalationPolicyName ? <Link to="/reliability/oncall">{s.escalationPolicyName}</Link> : 'Nobody is paged'}</dd>
              <dt>Support queue</dt><dd>{s.supportQueueName ?? '—'}</dd>
            </dl>
            {s.description ? <p className="sd-panel-pad sd-body">{s.description}</p> : null}
          </section>
          {manage ? (
            <section className="cc-panel" aria-label="Integrations">
              <header><h3>Alert integrations</h3><button type="button" className="sd-link-button" onClick={() => setAdding(true)}>Add</button></header>
              {revealed ? (
                <div className="sd-panel-pad auth-success" role="status">
                  <div>
                    <strong>{revealed.secret ? 'Copy the endpoint and secret now' : 'Copy the heartbeat URL now'}</strong>
                    <p>{revealed.secret ? 'The secret is not shown again. Sign each request with it.' : 'The URL is its own credential; it is not shown in full again after you leave.'}</p>
                    <code className="rl-code">{revealed.endpoint}</code>
                    {revealed.secret ? <code className="rl-code">{revealed.secret}</code> : null}
                  </div>
                  <button type="button" className="ghost-button" onClick={() => navigator.clipboard?.writeText(revealed.secret ? `${revealed.endpoint}\n${revealed.secret}` : revealed.endpoint)}><Copy size={14} aria-hidden="true" /> Copy</button>
                  <button type="button" className="ghost-button" onClick={() => setRevealed(null)}>Done</button>
                </div>
              ) : null}
              {adding ? <NewIntegration serviceId={s.id} onDone={(r) => { setAdding(false); if (r) setRevealed(r); invalidate(key); }} /> : null}
              {s.integrations.length === 0 && !adding ? <p className="cc-empty">No integrations. Connect a monitoring tool or a heartbeat so failures open incidents on their own.</p> : (
                <ul className="cc-rows">
                  {s.integrations.map((x) => (
                    <li key={x.id} className="sd-panel-pad rl-integration">
                      <div className="sd-inline"><strong>{x.name}</strong><span className="cc-tag">{x.kind === 'heartbeat' ? `Heartbeat · every ${x.heartbeatMinutes}m` : 'Webhook'}</span>{!x.isActive ? <span className="cc-tag">Paused</span> : null}{x.heartbeatMissedAt ? <span className="cc-tag cc-tag-critical">Missed</span> : null}</div>
                      <span className="field-hint">{x.lastReceivedAt ? `Last received ${relativeTime(x.lastReceivedAt)}` : 'Nothing received yet'}{x.kind === 'webhook' ? ` · secret ${x.secretFingerprint} · ${x.incidentSeverity ? `opens incidents at ${x.incidentSeverity}` : 'records only'}` : ''}</span>
                      {x.kind === 'webhook' ? <code className="rl-code">{x.endpoint}</code> : null}
                      <div className="sd-inline">
                        <button type="button" className="sd-link-button" onClick={() => void integrationAct(x.id, { rotate: true })}>{x.kind === 'heartbeat' ? 'New URL' : 'Rotate secret'}</button>
                        <button type="button" className="sd-link-button" onClick={() => void integrationAct(x.id, { isActive: !x.isActive })}>{x.isActive ? 'Pause' : 'Resume'}</button>
                        <button type="button" className="sd-link-button" onClick={async () => {
                          if (!window.confirm(`Delete the ${x.name} integration? Anything still sending to it will be refused.`)) return;
                          setError(null);
                          try { await api.delete(`/reliability/integrations/${x.id}`); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
                          invalidate(key);
                        }}>Delete</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </aside>
      </div>
      {editing ? <ServiceDialog service={s} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); invalidate(key); invalidate('/reliability/services'); }} /> : null}
    </div>
  );
}

function NewIntegration({ serviceId, onDone }: { serviceId: string; onDone: (r: { endpoint: string; secret: string | null } | null) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'webhook' | 'heartbeat'>('webhook');
  const [threshold, setThreshold] = useState<'critical' | 'warning' | ''>('critical');
  const [minutes, setMinutes] = useState('60');
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="sd-panel-pad sd-fields" onSubmit={async (e) => {
      e.preventDefault(); setError(null);
      try {
        const r = await api.post<{ endpoint: string; secret: string | null }>(`/reliability/services/${serviceId}/integrations`, {
          name, kind, incidentSeverity: kind === 'webhook' ? threshold || null : undefined, heartbeatMinutes: kind === 'heartbeat' ? Number(minutes) : undefined,
        });
        onDone(r);
      } catch (err) { setError(err instanceof ApiError ? err.message : 'The integration was not created.'); }
    }}>
      <label className="field"><span>Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} placeholder="Grafana alerts" /></label>
      <label className="field"><span>Type</span><select value={kind} onChange={(e) => setKind(e.target.value as 'webhook' | 'heartbeat')}><option value="webhook">Webhook from a monitoring tool</option><option value="heartbeat">Heartbeat from a scheduled job</option></select></label>
      {kind === 'webhook' ? (
        <label className="field"><span>Open an incident for</span><select value={threshold} onChange={(e) => setThreshold(e.target.value as 'critical' | 'warning' | '')}><option value="critical">Critical alerts</option><option value="warning">Warning and critical alerts</option><option value="">Nothing - record alerts only</option></select></label>
      ) : (
        <label className="field"><span>Expect a heartbeat every (minutes)</span><input type="number" min={1} max={10080} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
      )}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" className="ghost-button" onClick={() => onDone(null)}>Cancel</button><button type="submit" className="primary-button">Create</button></div>
    </form>
  );
}

export { SERVICE_STATUS_LABEL };
