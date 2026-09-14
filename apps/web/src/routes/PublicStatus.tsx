/**
 * The public status page, served from the public site without an account.
 *
 * Reads one anonymous endpoint that returns only what a manager marked public. Refreshes
 * every minute while open, so someone watching during an outage sees updates arrive.
 */
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useQuery } from '../lib/query';
import { formatDateTime } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/States';
import { formatAvailability, INCIDENT_STATUS_LABEL, SERVICE_STATUS_LABEL, ServiceStatusBadge, type IncidentStatus, type ServiceStatus } from '../lib/reliability';
import '../styles/command.css';
import '../styles/service.css';
import '../styles/reliability.css';

type PublicView = {
  title: string; intro: string | null; overall: ServiceStatus;
  services: { name: string; status: ServiceStatus; availability90d: number }[];
  incidents: { ref: string; title: string; status: IncidentStatus; startedAt: string; resolvedAt: string | null; updates: { body: string; status: IncidentStatus | null; createdAt: string }[] }[];
  maintenance: { title: string; description: string | null; startsAt: string; endsAt: string; services: string[] }[];
};

export default function PublicStatus() {
  const { slug } = useParams();
  const key = `/public/status/${slug}`;
  const view = useQuery<PublicView>(slug ? key : null, (s) => api.get(key, s), { ttlMs: 30_000 });
  useEffect(() => { const t = window.setInterval(() => view.reload(), 60_000); return () => window.clearInterval(t); }, [view]);
  useEffect(() => { if (view.data) document.title = view.data.title; }, [view.data]);

  if (view.loading && !view.data) return <div className="status-public"><Loading label="Loading status" rows={4} /></div>;
  if (view.error && !view.data) return <div className="status-public">{(view.error as { status?: number }).status === 404 ? <Empty title="Status page not found" description="Check the address." /> : <ErrorState error={view.error} onRetry={view.reload} />}</div>;
  const v = view.data!;
  const open = v.incidents.filter((i) => i.status !== 'resolved');
  const recent = v.incidents.filter((i) => i.status === 'resolved');

  return (
    <main className="status-public">
      <header>
        <h1>{v.title}</h1>
        {v.intro ? <p className="field-hint">{v.intro}</p> : null}
      </header>
      <div className={`rl-banner rl-banner-${v.overall}`} role="status">
        <strong>{v.overall === 'operational' ? 'All systems operational' : SERVICE_STATUS_LABEL[v.overall]}</strong>
      </div>

      {open.map((i) => <IncidentCard key={i.ref} incident={i} />)}

      {v.maintenance.length > 0 ? (
        <section className="cc-panel" aria-label="Scheduled maintenance">
          <header><h3>Scheduled maintenance</h3></header>
          <ul className="cc-rows">{v.maintenance.map((m, n) => (
            <li key={n} className="cc-row"><span className="cc-row-main"><strong>{m.title}</strong><span>{formatDateTime(m.startsAt)} – {formatDateTime(m.endsAt)} · {m.services.join(', ')}</span>{m.description ? <span>{m.description}</span> : null}</span></li>
          ))}</ul>
        </section>
      ) : null}

      <section className="cc-panel" aria-label="Services">
        <header><h3>Services</h3><span className="cc-meta">90-day availability</span></header>
        {v.services.length === 0 ? <p className="cc-empty">No services are listed.</p> : (
          <ul className="cc-rows">{v.services.map((s) => (
            <li key={s.name} className="cc-row"><span className="cc-row-main"><strong>{s.name}</strong></span><span className="rl-uptime cc-meta">{formatAvailability(s.availability90d)}</span><ServiceStatusBadge status={s.status} /></li>
          ))}</ul>
        )}
      </section>

      {recent.length > 0 ? (
        <section aria-label="Recently resolved">
          <h3 className="sd-subhead">Resolved in the last 7 days</h3>
          {recent.map((i) => <IncidentCard key={i.ref} incident={i} />)}
        </section>
      ) : null}
      <p className="status-public-foot">Updated {formatDateTime(new Date().toISOString())}</p>
    </main>
  );
}

function IncidentCard({ incident: i }: { incident: PublicView['incidents'][number] }) {
  return (
    <section className="cc-panel" aria-label={i.title}>
      <header><h3>{i.title}</h3><span className={`sd-badge rl-inc-${i.status}`}>{INCIDENT_STATUS_LABEL[i.status]}</span></header>
      <ol className="rl-timeline">
        {i.updates.length === 0 ? <li><span /><span /><p className="sd-body">We are aware of the issue and investigating.</p></li> : i.updates.map((u, n) => (
          <li key={n}>
            <time dateTime={u.createdAt}>{new Date(u.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
            <span className={`rl-dot rl-dot-${u.status === 'resolved' ? 'alert_resolved' : 'public_update'}`} aria-hidden="true" />
            <div>{u.status ? <div className="rl-event-head"><strong>{INCIDENT_STATUS_LABEL[u.status]}</strong></div> : null}<p className="sd-body">{u.body}</p></div>
          </li>
        ))}
      </ol>
    </section>
  );
}
