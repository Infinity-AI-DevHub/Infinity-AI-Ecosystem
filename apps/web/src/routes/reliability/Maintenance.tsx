/**
 * Maintenance windows, alerts and reliability reports.
 *
 * A window marks services as under maintenance while it runs, optionally shows on the
 * public status page, and silences paging for alerts on those services - alerts are still
 * recorded, flagged as suppressed.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { formatAvailability } from '../../lib/reliability';
import { formatMinutes } from '../../lib/service';
import type { ServiceSummary } from './Overview';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/reliability.css';

type Window = { id: string; title: string; description: string | null; startsAt: string; endsAt: string; isPublic: boolean; suppressAlerts: boolean; status: string; phase: string; change: { id: string; ref: string } | null; services: { id: string; name: string }[] };

const pad = (n: number) => String(n).padStart(2, '0');
const toLocal = (v: string | Date) => { const d = new Date(v); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export default function Maintenance() {
  const { can } = useSession();
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const key = `/reliability/maintenance?scope=${scope}`;
  const list = useQuery<{ items: Window[] }>(key, (s) => api.get(key, s));
  const [editing, setEditing] = useState<Window | 'new' | null>(null);
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Reliability</p><h2>Maintenance</h2></div>
        <div className="cc-header-side">{can('reliability.manage') ? <button type="button" className="primary-button" onClick={() => setEditing('new')}><Plus size={15} aria-hidden="true" /> Schedule maintenance</button> : null}</div>
      </header>
      <div className="tab-row" role="tablist" aria-label="Maintenance views">
        {(['upcoming', 'past'] as const).map((s) => <button key={s} type="button" role="tab" aria-selected={scope === s} className={`tab ${scope === s ? 'tab-active' : ''}`} onClick={() => setScope(s)}>{s === 'upcoming' ? 'Upcoming and running' : 'Past'}</button>)}
      </div>
      {list.loading && !list.data ? <Loading rows={4} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No maintenance" description="Planned work on services - upgrades, migrations, provider maintenance - is scheduled here." />
        : (
          <ul className="cc-panel cc-rows">
            {list.data!.items.map((w) => (
              <li key={w.id} className="cc-row">
                <span className="cc-row-main">
                  <strong>{w.title}</strong>
                  <span>{formatDateTime(w.startsAt)} – {formatDateTime(w.endsAt)} · {w.services.map((s) => s.name).join(', ')}{w.isPublic ? ' · public' : ''}{w.suppressAlerts ? ' · paging paused' : ''}</span>
                </span>
                {w.change ? <Link className="cc-tag cc-tag-info" to={`/service/changes/${w.change.id}`}>{w.change.ref}</Link> : null}
                <span className={`cc-tag ${w.phase === 'in_progress' ? 'cc-tag-info' : ''}`}>{w.phase.replace('_', ' ')}</span>
                {can('reliability.manage') && w.phase !== 'completed' && w.phase !== 'cancelled' ? <button type="button" className="sd-link-button" onClick={() => setEditing(w)}>Edit</button> : null}
              </li>
            ))}
          </ul>
        )}
      {editing ? <WindowDialog window={editing === 'new' ? null : editing} onClose={() => { setEditing(null); invalidate('/reliability/'); }} /> : null}
    </div>
  );
}

function WindowDialog({ window: w, onClose }: { window: Window | null; onClose: () => void }) {
  const services = useQuery<{ items: ServiceSummary[] }>('/reliability/services', (s) => api.get('/reliability/services', s));
  const changes = useQuery<{ items: { id: string; ref: string; title: string }[] }>('/service/changes?status=open&limit=100', (s) => api.get('/service/changes?status=open&limit=100', s));
  const soon = new Date(Date.now() + 86400000);
  const [f, setF] = useState({
    title: w?.title ?? '', description: w?.description ?? '', startsAt: toLocal(w?.startsAt ?? soon), endsAt: toLocal(w?.endsAt ?? new Date(soon.getTime() + 2 * 3600000)),
    isPublic: w?.isPublic ?? true, suppressAlerts: w?.suppressAlerts ?? true, serviceIds: w?.services.map((s) => s.id) ?? [], changeId: w?.change?.id ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (cancelled: boolean) => {
    setError(null);
    const body = { ...f, description: f.description || null, changeId: f.changeId || null, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), cancelled };
    try { if (w) await api.put(`/reliability/maintenance/${w.id}`, body); else await api.post('/reliability/maintenance', body); onClose(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'The maintenance window was not saved.'); }
  };
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="mw-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
        <h3 id="mw-title">{w ? 'Edit maintenance' : 'Schedule maintenance'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Title</span><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={300} placeholder="Database upgrade" /></label>
          <label className="field"><span>Starts</span><input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} required /></label>
          <label className="field"><span>Ends</span><input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} required /></label>
          <label className="field sd-span-2"><span>What to expect</span><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={5000} placeholder="Shown on the status page if public" /></label>
          <fieldset className="field sd-span-2">
            <legend>Services</legend>
            {services.data?.items.map((s) => (
              <label key={s.id} className="sd-check"><input type="checkbox" checked={f.serviceIds.includes(s.id)} onChange={(e) => setF({ ...f, serviceIds: e.target.checked ? [...f.serviceIds, s.id] : f.serviceIds.filter((x) => x !== s.id) })} /> {s.name}</label>
            ))}
          </fieldset>
          <label className="field sd-span-2"><span>Related change</span><select value={f.changeId} onChange={(e) => setF({ ...f, changeId: e.target.value })}><option value="">None</option>{changes.data?.items.map((c) => <option key={c.id} value={c.id}>{c.ref} · {c.title}</option>)}</select></label>
          <label className="sd-check"><input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} /> Show on the public status page</label>
          <label className="sd-check"><input type="checkbox" checked={f.suppressAlerts} onChange={(e) => setF({ ...f, suppressAlerts: e.target.checked })} /> Do not page for alerts during the window</label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {w ? <button type="button" className="ghost-button" onClick={() => void submit(true)}>Cancel maintenance</button> : null}
          {w && (w.phase === 'upcoming' || w.phase === 'cancelled') ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete "${w.title}"?`)) return;
            try { await api.delete(`/reliability/maintenance/${w.id}`); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          <button type="submit" className="primary-button" disabled={f.serviceIds.length === 0}>Save</button>
        </div>
      </form>
    </div>
  );
}

export function AlertsPage() {
  const [status, setStatus] = useState<'firing' | 'resolved' | ''>('firing');
  const key = `/reliability/alerts?limit=100${status ? `&status=${status}` : ''}`;
  const list = useQuery<{ items: { id: string; title: string; severity: string; status: string; occurrences: number; firstSeenAt: string; lastSeenAt: string; suppressed: boolean; sourceUrl: string | null; serviceId: string; serviceName: string; integrationName: string; incident: { id: string; ref: string } | null }[] }>(key, (s) => api.get(key, s));
  return (
    <div className="module-page cc-page">
      <header className="cc-header"><div><p className="cc-eyebrow">Reliability</p><h2>Alerts</h2></div></header>
      <div className="tab-row" role="tablist" aria-label="Alert views">
        {([['firing', 'Firing'], ['resolved', 'Resolved'], ['', 'All']] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={status === id} className={`tab ${status === id ? 'tab-active' : ''}`} onClick={() => setStatus(id)}>{label}</button>)}
      </div>
      {list.loading && !list.data ? <Loading rows={4} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title={status === 'firing' ? 'Nothing firing' : 'No alerts'} description="Alerts arrive from the monitoring integrations on each service." />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Alert</th><th scope="col">Service</th><th scope="col">Severity</th><th scope="col">Seen</th><th scope="col">Incident</th></tr></thead>
              <tbody>
                {list.data!.items.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{a.title}<span className="sd-sub">{a.integrationName}{a.suppressed ? ' · suppressed by maintenance' : ''}{a.status === 'resolved' ? ' · resolved' : ''}</span></th>
                    <td><Link to={`/reliability/services/${a.serviceId}`}>{a.serviceName}</Link></td>
                    <td><span className={`cc-tag ${a.severity === 'critical' ? 'cc-tag-critical' : ''}`}>{a.severity}</span></td>
                    <td>{a.occurrences}× · last {relativeTime(a.lastSeenAt)}</td>
                    <td>{a.incident ? <Link to={`/reliability/incidents/${a.incident.id}`}>{a.incident.ref}</Link> : <span className="sd-muted">—</span>}{a.sourceUrl ? <> · <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener">Source</a></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

export function ReliabilityReport() {
  const [days, setDays] = useState(30);
  const key = `/reliability/report?days=${days}`;
  const data = useQuery<{
    days: number; incidents: number; bySeverity: { severity: string; count: number }[]; fromAlerts: number;
    meanTimeToAcknowledgeMinutes: number | null; meanTimeToResolveMinutes: number | null;
    alerts: { total: number; suppressed: number; openedIncidents: number }; postmortems: { due: number; published: number };
    services: { id: string; name: string; tier: string; availability: number; incidents: number }[];
  }>(key, (s) => api.get(key, s));
  if (data.error && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading label="Loading report" rows={5} />;
  const r = data.data;
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Reliability</p><h2>Reliability report</h2></div>
        <label className="nc-kind"><span className="visually-hidden">Period</span><select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select></label>
      </header>
      <section className="cc-panel" aria-label="Incident response">
        <header><h3>Incident response</h3></header>
        <dl className="cc-stats">
          <div><dt>Incidents</dt><dd>{r.incidents}</dd></div>
          <div><dt>Mean time to acknowledge</dt><dd>{formatMinutes(r.meanTimeToAcknowledgeMinutes)}</dd></div>
          <div><dt>Mean time to resolve</dt><dd>{formatMinutes(r.meanTimeToResolveMinutes)}</dd></div>
          <div className={r.postmortems.due > r.postmortems.published ? 'is-critical' : ''}><dt>SEV1/2 postmortems published</dt><dd>{r.postmortems.published}/{r.postmortems.due}</dd></div>
        </dl>
        <dl className="cc-stats">
          {r.bySeverity.map((s) => <div key={s.severity}><dt>{s.severity.toUpperCase()}</dt><dd>{s.count}</dd></div>)}
        </dl>
        <dl className="cc-stats cc-stats-3">
          <div><dt>Alerts received</dt><dd>{r.alerts.total}</dd></div>
          <div><dt>Opened incidents</dt><dd>{r.alerts.openedIncidents}</dd></div>
          <div><dt>Suppressed by maintenance</dt><dd>{r.alerts.suppressed}</dd></div>
        </dl>
      </section>
      <section className="cc-panel" aria-label="Availability by service">
        <header><h3>Availability by service</h3></header>
        {r.services.length === 0 ? <p className="cc-empty">No services.</p> : (
          <ul className="sd-bars">
            {r.services.map((s) => (
              <li key={s.id}>
                <Link to={`/reliability/services/${s.id}`}>{s.name}</Link>
                <span className={`sd-bar ${s.availability < 99.5 ? 'sd-bar-urgent' : s.availability < 99.9 ? 'sd-bar-high' : ''}`} aria-hidden="true"><span style={{ width: `${Math.max(2, (s.availability - 95) * 20)}%` }} /></span>
                <span className="sd-bar-value rl-uptime">{formatAvailability(s.availability)} · {s.incidents} {s.incidents === 1 ? 'incident' : 'incidents'}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="field-hint sd-panel-pad">Partial and major outages count as unavailable. Degraded performance and maintenance do not. The bar starts at 95%.</p>
      </section>
    </div>
  );
}
