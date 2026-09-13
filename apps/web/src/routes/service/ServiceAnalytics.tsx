/**
 * Support analytics: how the desk is doing over a period, for the people who run it.
 * Scoped by the server to the queues the viewer works, or everything for overseers.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { Empty, ErrorState, Forbidden, Loading } from '../../components/States';
import { formatMinutes, PRIORITY_LABEL, type TicketPriority } from '../../lib/service';
import '../../styles/command.css';
import '../../styles/service.css';

type Analytics = {
  days: number;
  open: number; unassigned: number; breached: number; created: number; resolved: number;
  averageFirstResponseMinutes: number | null;
  averageResolutionMinutes: number | null;
  firstResponseSlaRate: number | null;
  byQueue: { queueId: string; name: string; open: number; breached: number }[];
  byPriority: { priority: TicketPriority; open: number }[];
  satisfaction: { average: number | null; responses: number };
};

export default function ServiceAnalytics() {
  const [days, setDays] = useState(30);
  const key = `/service/analytics?days=${days}`;
  const data = useQuery<Analytics>(key, (signal) => api.get(key, signal));

  if (data.error && !data.data) {
    return data.error instanceof ApiError && data.error.status === 403
      ? <Forbidden message="Support analytics are for people who work a service desk queue." />
      : <ErrorState error={data.error} onRetry={data.reload} />;
  }
  if (!data.data) return <Loading label="Loading analytics" rows={5} />;
  const a = data.data;
  const maxQueue = Math.max(1, ...a.byQueue.map((q) => q.open));
  const maxPriority = Math.max(1, ...a.byPriority.map((p) => p.open));

  return (
    <div className="module-page cc-page">
      <Link to="/service" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Service desk</Link>
      <header className="cc-header">
        <div>
          <p className="cc-eyebrow">Service</p>
          <h2>Support analytics</h2>
        </div>
        <label className="nc-kind">
          <span className="visually-hidden">Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </header>

      <section className="cc-panel" aria-label="Right now">
        <header><h3>Right now</h3></header>
        <dl className="cc-stats">
          <div><dt>Open tickets</dt><dd>{a.open}</dd></div>
          <div className={a.unassigned > 0 ? 'is-critical' : ''}><dt>Unassigned</dt><dd>{a.unassigned}</dd></div>
          <div className={a.breached > 0 ? 'is-critical' : ''}><dt>SLA breached</dt><dd>{a.breached}</dd></div>
          <div><dt>Satisfaction</dt><dd>{a.satisfaction.average === null ? '—' : `${a.satisfaction.average}/5`}</dd></div>
        </dl>
      </section>

      <section className="cc-panel" aria-label={`Last ${a.days} days`}>
        <header><h3>Last {a.days} days</h3></header>
        <dl className="cc-stats">
          <div><dt>Raised</dt><dd>{a.created}</dd></div>
          <div><dt>Resolved</dt><dd>{a.resolved}</dd></div>
          <div><dt>Avg first response</dt><dd>{formatMinutes(a.averageFirstResponseMinutes)}</dd></div>
          <div><dt>Avg resolution</dt><dd>{formatMinutes(a.averageResolutionMinutes)}</dd></div>
        </dl>
        <dl className="cc-stats cc-stats-2">
          <div className={a.firstResponseSlaRate !== null && a.firstResponseSlaRate < 90 ? 'is-critical' : a.firstResponseSlaRate !== null ? 'is-ok' : ''}>
            <dt>First responses on time</dt><dd>{a.firstResponseSlaRate === null ? '—' : `${a.firstResponseSlaRate}%`}</dd>
          </div>
          <div><dt>Ratings received</dt><dd>{a.satisfaction.responses}</dd></div>
        </dl>
      </section>

      <div className="cc-grid">
        <section className="cc-panel" aria-label="Open by queue">
          <header><h3>Open by queue</h3></header>
          {a.byQueue.length === 0 ? <Empty title="No queues" /> : (
            <ul className="sd-bars">
              {a.byQueue.map((q) => (
                <li key={q.queueId}>
                  <Link to={`/service?view=all&queue=${q.queueId}`}>{q.name}</Link>
                  <span className="sd-bar" aria-hidden="true"><span style={{ width: `${(q.open / maxQueue) * 100}%` }} /></span>
                  <span className="sd-bar-value">{q.open}{q.breached ? <em> · {q.breached} breached</em> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="cc-panel" aria-label="Open by priority">
          <header><h3>Open by priority</h3></header>
          <ul className="sd-bars">
            {a.byPriority.map((p) => (
              <li key={p.priority}>
                <Link to={`/service?view=all&priority=${p.priority}`}>{PRIORITY_LABEL[p.priority]}</Link>
                <span className={`sd-bar sd-bar-${p.priority}`} aria-hidden="true"><span style={{ width: `${(p.open / maxPriority) * 100}%` }} /></span>
                <span className="sd-bar-value">{p.open}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
