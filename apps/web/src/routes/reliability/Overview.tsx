/**
 * Reliability overview: the internal status page. What is broken, who is on it, who is on
 * call, and what maintenance is coming - with the one action that matters most in an
 * emergency, declaring an incident, always in reach.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Radio, Siren } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import {
  formatAvailability, IMPACT_LABEL, IncidentStatusBadge, SERVICE_STATUS_LABEL, SeverityBadge, ServiceStatusBadge,
  type Impact, type IncidentStatus, type ServiceStatus, type Severity,
} from '../../lib/reliability';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/reliability.css';

export type ServiceSummary = {
  id: string; name: string; tier: string; status: ServiceStatus; availability30d: number | null; openIncidents: number;
  ownerName: string | null; escalationPolicyName: string | null; supportQueueName: string | null; isPublic: boolean; isActive: boolean;
};
type IncidentSummary = { id: string; ref: string; title: string; severity: Severity; status: IncidentStatus; services: string; commanderName: string | null; detectedAt: string; acknowledgedAt: string | null; responders: number };
type Schedule = { id: string; name: string; current: { name: string; until: string; override: boolean } | null };
type Status = { overall: ServiceStatus; maintenance: { id: string; title: string; startsAt: string; endsAt: string; services: string[] }[] };

export default function ReliabilityOverview() {
  const { can } = useSession();
  const navigate = useNavigate();
  const services = useQuery<{ items: ServiceSummary[] }>('/reliability/services', (s) => api.get('/reliability/services', s));
  const incidents = useQuery<{ items: IncidentSummary[] }>('/reliability/incidents?status=open&limit=50', (s) => api.get('/reliability/incidents?status=open&limit=50', s));
  const schedules = useQuery<{ items: Schedule[] }>('/reliability/schedules', (s) => api.get('/reliability/schedules', s));
  const status = useQuery<Status>('/reliability/status', (s) => api.get('/reliability/status', s));
  const [declaring, setDeclaring] = useState(false);

  if ((services.loading && !services.data) || (incidents.loading && !incidents.data)) return <Loading label="Loading service health" rows={6} />;
  if (services.error && !services.data) return <ErrorState error={services.error} onRetry={services.reload} />;
  const svc = services.data!.items;
  const open = incidents.data?.items ?? [];
  const overall = status.data?.overall ?? 'operational';

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Engineering</p><h2>Reliability</h2></div>
        <div className="cc-header-side">
          {can('incident.declare') ? (
            <button type="button" className="primary-button rl-declare" onClick={() => setDeclaring(true)} disabled={svc.length === 0}>
              <Siren size={15} aria-hidden="true" /> Declare incident
            </button>
          ) : null}
        </div>
      </header>

      {svc.length === 0 ? (
        <Empty title="No services yet" description={can('reliability.manage') ? 'Add the systems people depend on - websites, APIs, internal tools - to track their health and page the right people.' : 'A reliability manager needs to add services first.'}
          action={can('reliability.manage') ? <Link className="primary-button" to="/reliability/services">Add services</Link> : undefined} />
      ) : (
        <>
          <div className={`rl-banner rl-banner-${overall}`} role="status">
            <ServiceStatusBadge status={overall} />
            <strong>{overall === 'operational' ? 'All services operational' : open.length ? `${open.length} open ${open.length === 1 ? 'incident' : 'incidents'}` : SERVICE_STATUS_LABEL[overall]}</strong>
          </div>

          {open.length > 0 ? (
            <section className="cc-panel" aria-label="Open incidents">
              <header><h3>Open incidents</h3><Link to="/reliability/incidents" className="cc-panel-link">All incidents</Link></header>
              <ul className="cc-rows">
                {open.map((i) => (
                  <li key={i.id}>
                    <Link to={`/reliability/incidents/${i.id}`} className="cc-row">
                      <SeverityBadge severity={i.severity} />
                      <span className="cc-row-main">
                        <strong>{i.ref} · {i.title}</strong>
                        <span>{i.services} · {i.commanderName ? `led by ${i.commanderName}` : 'no commander'} · {i.responders} responding · started {relativeTime(i.detectedAt)}</span>
                      </span>
                      {!i.acknowledgedAt ? <span className="cc-tag cc-tag-critical">Unacknowledged</span> : null}
                      <IncidentStatusBadge status={i.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="cc-panel" aria-label="Services">
            <header><h3>Services</h3><Link to="/reliability/services" className="cc-panel-link">Manage</Link></header>
            <div className="rl-services">
              {svc.map((s) => (
                <Link key={s.id} to={`/reliability/services/${s.id}`} className="rl-service">
                  <strong>{s.name}</strong>
                  <ServiceStatusBadge status={s.status} />
                  <span className="cc-meta">30-day availability {formatAvailability(s.availability30d)}{s.tier === 'critical' ? ' · critical' : ''}</span>
                </Link>
              ))}
            </div>
          </section>

          <div className="cc-grid">
            <section className="cc-panel" aria-label="On call now">
              <header><Radio size={14} aria-hidden="true" /><h3>On call now</h3><Link to="/reliability/oncall" className="cc-panel-link">Schedules</Link></header>
              {!schedules.data ? <Loading rows={2} /> : schedules.data.items.length === 0 ? <p className="cc-empty">No on-call schedules.</p> : (
                <ul className="cc-rows">
                  {schedules.data.items.map((s) => (
                    <li key={s.id} className="cc-row">
                      <span className="cc-row-main"><strong>{s.current?.name ?? 'Nobody'}</strong><span>{s.name}{s.current ? ` · until ${formatDateTime(s.current.until)}` : ''}{s.current?.override ? ' · covering' : ''}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="cc-panel" aria-label="Upcoming maintenance">
              <header><h3>Maintenance</h3><Link to="/reliability/maintenance" className="cc-panel-link">Schedule</Link></header>
              {!status.data ? <Loading rows={2} /> : status.data.maintenance.length === 0 ? <p className="cc-empty">Nothing planned in the next two weeks.</p> : (
                <ul className="cc-rows">
                  {status.data.maintenance.map((m) => (
                    <li key={m.id} className="cc-row"><span className="cc-row-main"><strong>{m.title}</strong><span>{formatDateTime(m.startsAt)} – {formatDateTime(m.endsAt)} · {m.services.join(', ')}</span></span></li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {can('reliability.manage') ? <StatusPageSettings /> : null}
        </>
      )}

      {declaring ? <DeclareDialog services={svc.filter((s) => s.isActive)} onClose={() => setDeclaring(false)} onDeclared={(id) => { setDeclaring(false); invalidate('/reliability'); navigate(`/reliability/incidents/${id}`); }} /> : null}
    </div>
  );
}

export function DeclareDialog({ services, onClose, onDeclared }: { services: ServiceSummary[]; onClose: () => void; onDeclared: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<Severity>('sev2');
  const [summary, setSummary] = useState('');
  const [affected, setAffected] = useState<Record<string, Impact>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="declare-title" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setPending(true); setError(null);
          try {
            const created = await api.post<{ id: string }>('/reliability/incidents', {
              title, severity, summary: summary || null, services: Object.entries(affected).map(([serviceId, impact]) => ({ serviceId, impact })),
            });
            onDeclared(created.id);
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The incident was not declared.'); setPending(false); }
        }}>
        <h3 id="declare-title">Declare an incident</h3>
        <p className="field-hint">The on-call responders for the most critical affected service are paged immediately.</p>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>What is happening?</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={300} placeholder="Customers cannot log in" /></label>
          <label className="field"><span>Severity</span>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              <option value="sev1">SEV1 - critical, widespread outage</option>
              <option value="sev2">SEV2 - major, many users affected</option>
              <option value="sev3">SEV3 - minor, limited impact</option>
              <option value="sev4">SEV4 - low, cosmetic or internal</option>
            </select>
          </label>
          <label className="field sd-span-2"><span>What we know</span><textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={20000} /></label>
          <fieldset className="field sd-span-2 rl-affected">
            <legend>Affected services</legend>
            {services.map((s) => (
              <div key={s.id} className="sd-inline">
                <label className="sd-check"><input type="checkbox" checked={Boolean(affected[s.id])} onChange={(e) => { const next = { ...affected }; if (e.target.checked) next[s.id] = 'partial_outage'; else delete next[s.id]; setAffected(next); }} /> {s.name}</label>
                {affected[s.id] ? (
                  <select aria-label={`${s.name} impact`} value={affected[s.id]} onChange={(e) => setAffected({ ...affected, [s.id]: e.target.value as Impact })}>
                    {(Object.keys(IMPACT_LABEL) as Impact[]).map((k) => <option key={k} value={k}>{IMPACT_LABEL[k]}</option>)}
                  </select>
                ) : null}
              </div>
            ))}
          </fieldset>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={pending || Object.keys(affected).length === 0}>{pending ? 'Declaring…' : 'Declare and page'}</button>
        </div>
      </form>
    </div>
  );
}

function StatusPageSettings() {
  const settings = useQuery<{ configured: boolean; slug: string | null; title: string | null; intro: string | null; isEnabled: boolean; url: string | null }>('/reliability/status-page', (s) => api.get('/reliability/status-page', s));
  const [form, setForm] = useState<{ slug: string; title: string; intro: string; isEnabled: boolean } | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  if (!settings.data) return null;
  const f = form ?? { slug: settings.data.slug ?? '', title: settings.data.title ?? '', intro: settings.data.intro ?? '', isEnabled: settings.data.isEnabled };
  return (
    <section className="cc-panel" aria-label="Public status page">
      <header><h3>Public status page</h3>{settings.data.isEnabled ? <span className="cc-tag cc-tag-info">Live</span> : <span className="cc-tag">Off</span>}</header>
      <form className="sd-panel-pad sd-editor" onSubmit={async (e) => {
        e.preventDefault(); setMessage(null);
        try { await api.put('/reliability/status-page', { ...f, intro: f.intro || null }); setMessage({ kind: 'ok', text: 'Status page saved.' }); setForm(null); }
        catch (err) { setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'The status page was not saved.' }); }
        invalidate('/reliability/status-page');
      }}>
        <p className="field-hint">Shows only services marked public, incidents marked public, and updates published as public. Internal notes never appear.</p>
        <div className="sd-form-grid">
          <label className="field"><span>Address</span><input value={f.slug} onChange={(e) => setForm({ ...f, slug: e.target.value })} required minLength={3} maxLength={60} placeholder="infinity-ai" /></label>
          <label className="field"><span>Title</span><input value={f.title} onChange={(e) => setForm({ ...f, title: e.target.value })} required maxLength={160} placeholder="Infinity AI status" /></label>
          <label className="field sd-span-2"><span>Introduction</span><input value={f.intro} onChange={(e) => setForm({ ...f, intro: e.target.value })} maxLength={500} /></label>
          <label className="sd-check"><input type="checkbox" checked={f.isEnabled} onChange={(e) => setForm({ ...f, isEnabled: e.target.checked })} /> Page is public</label>
        </div>
        {settings.data.url ? <p className="field-hint">Address: <code>{settings.data.url}</code></p> : null}
        {message ? <p className={message.kind === 'ok' ? 'field-hint sd-ok' : 'field-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}
        <div className="dialog-actions"><button type="submit" className="primary-button">Save status page</button></div>
      </form>
    </section>
  );
}
