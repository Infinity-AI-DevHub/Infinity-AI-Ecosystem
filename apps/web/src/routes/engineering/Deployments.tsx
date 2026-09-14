/**
 * Deployments across the catalogue: what shipped where, from which source, whether it
 * worked, and the rate at which releases fail.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { DEPLOYMENT_LABEL, DeploymentBadge, shortSha, type Deployment, type DeploymentStatus } from '../../lib/engineering';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/engineering.css';

type Feed = { items: Deployment[]; stats: { days: number; total: number; production: number; failed: number; perWeek: number; changeFailureRate: number | null } };

export default function Deployments() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const serviceId = params.get('serviceId') ?? '';
  const [status, setStatus] = useState('');
  const [production, setProduction] = useState(false);
  const [days, setDays] = useState(30);
  const services = useQuery<{ items: { id: string; name: string }[] }>('/engineering/services', (s) => api.get('/engineering/services', s));
  const q = new URLSearchParams({ days: String(days), limit: '100' });
  if (serviceId) q.set('serviceId', serviceId);
  if (status) q.set('status', status);
  if (production) q.set('production', 'true');
  const key = `/engineering/deployments?${q}`;
  const feed = useQuery<Feed>(key, (s) => api.get(key, s));

  const act = async (id: string, next: DeploymentStatus) => {
    try { await api.patch(`/engineering/deployments/${id}`, { status: next }); } catch (err) { window.alert(err instanceof ApiError ? err.message : 'Not updated.'); }
    invalidate('/engineering/');
  };

  return (
    <div className="module-page cc-page">
      <header className="cc-header"><div><p className="cc-eyebrow">Engineering</p><h2>Deployments</h2></div></header>
      <div className="sd-toolbar">
        <div className="sd-filters">
          <select aria-label="Service" value={serviceId} onChange={(e) => { const next = new URLSearchParams(params); if (e.target.value) next.set('serviceId', e.target.value); else next.delete('serviceId'); setParams(next, { replace: true }); }}>
            <option value="">All services</option>{services.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any result</option>{Object.entries(DEPLOYMENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
          <label className="sd-check"><input type="checkbox" checked={production} onChange={(e) => setProduction(e.target.checked)} /> Production only</label>
        </div>
      </div>
      {feed.data ? (
        <section className="cc-panel" aria-label="Delivery">
          <dl className="cc-stats">
            <div><dt>Deployments</dt><dd>{feed.data.stats.total}</dd></div>
            <div><dt>Per week</dt><dd>{feed.data.stats.perWeek}</dd></div>
            <div><dt>To production</dt><dd>{feed.data.stats.production}</dd></div>
            <div className={(feed.data.stats.changeFailureRate ?? 0) > 15 ? 'is-critical' : ''}><dt>Change failure rate</dt><dd>{feed.data.stats.changeFailureRate === null ? '—' : `${feed.data.stats.changeFailureRate}%`}</dd></div>
          </dl>
        </section>
      ) : null}
      {feed.loading && !feed.data ? <Loading rows={5} /> : feed.error && !feed.data ? <ErrorState error={feed.error} onRetry={feed.reload} />
        : feed.data!.items.length === 0 ? <Empty title="No deployments" description="Deployments arrive from GitHub or GitLab once a repository is linked to a service, or are recorded from a service's page." />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Release</th><th scope="col">Service</th><th scope="col">Environment</th><th scope="col">Result</th><th scope="col">By</th><th scope="col">When</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                {feed.data!.items.map((d) => (
                  <tr key={d.id}>
                    <th scope="row">
                      {d.url ? <a href={d.url} target="_blank" rel="noreferrer noopener">{d.version ?? shortSha(d.commitSha) ?? 'Unversioned'}</a> : d.version ?? shortSha(d.commitSha) ?? 'Unversioned'}
                      <span className="sd-sub">{d.version && d.commitSha ? <span className="eg-mono">{shortSha(d.commitSha)} </span> : null}{d.notes ?? ''}</span>
                    </th>
                    <td><Link to={`/engineering/services/${d.service.id}`}>{d.service.name}</Link></td>
                    <td>{d.environment.name}{d.change ? <span className="sd-sub"><Link to={`/service/changes/${d.change.id}`}>{d.change.ref}</Link></span> : d.withoutChange ? <span className="sd-sub">No change record</span> : null}</td>
                    <td><DeploymentBadge status={d.status} /></td>
                    <td>{d.deployedBy ?? '—'}<span className="sd-sub">{d.source === 'manual' ? 'By hand' : d.source === 'github' ? 'GitHub' : 'GitLab'}</span></td>
                    <td>{formatDateTime(d.startedAt)}</td>
                    <td>
                      {can('deployment.record') && d.source === 'manual' && d.status === 'in_progress' ? <><button type="button" className="sd-link-button" onClick={() => void act(d.id, 'succeeded')}>Succeeded</button> · <button type="button" className="sd-link-button" onClick={() => void act(d.id, 'failed')}>Failed</button></> : null}
                      {can('deployment.record') && (d.status === 'succeeded' || d.status === 'failed') ? <button type="button" className="sd-link-button" onClick={() => void act(d.id, 'rolled_back')}>Rolled back</button> : null}
                      {can('engineering.manage') && d.source === 'manual' ? <button type="button" className="sd-link-button" onClick={async () => {
                        if (!window.confirm('Delete this deployment record? Use this only for one recorded by mistake.')) return;
                        try { await api.delete(`/engineering/deployments/${d.id}`); } catch (err) { window.alert(err instanceof ApiError ? err.message : 'Not deleted.'); }
                        invalidate('/engineering/');
                      }}>Delete</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

export function RecordDeploymentDialog({ serviceId, environments, onClose }: { serviceId: string; environments: { id: string; name: string; kind: string }[]; onClose: () => void }) {
  const changes = useQuery<{ items: { id: string; ref: string; title: string }[] }>('/service/changes?limit=100', (s) => api.get('/service/changes?limit=100', s));
  const [f, setF] = useState({ environmentId: environments.find((e) => e.kind === 'production')?.id ?? environments[0]?.id ?? '', version: '', commitSha: '', status: 'succeeded' as DeploymentStatus, url: '', notes: '', changeId: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="deploy-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try {
            await api.post(`/engineering/services/${serviceId}/deployments`, { ...f, version: f.version || null, commitSha: f.commitSha || null, url: f.url || null, notes: f.notes || null, changeId: f.changeId || null });
            onClose();
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The deployment was not recorded.'); }
        }}>
        <h3 id="deploy-title">Record a deployment</h3>
        <p className="field-hint">For releases that do not come through GitHub or GitLab.</p>
        <div className="sd-form-grid">
          <label className="field"><span>Environment</span><select autoFocus value={f.environmentId} onChange={(e) => setF({ ...f, environmentId: e.target.value })}>{environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
          <label className="field"><span>Result</span><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as DeploymentStatus })}>{Object.entries(DEPLOYMENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Version</span><input maxLength={80} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="2.4.0" /></label>
          <label className="field"><span>Commit</span><input maxLength={64} pattern="[0-9a-fA-F]{7,64}" title="7 to 64 hexadecimal characters" value={f.commitSha} onChange={(e) => setF({ ...f, commitSha: e.target.value })} placeholder="a1b2c3d" /></label>
          <label className="field sd-span-2"><span>Related change</span><select value={f.changeId} onChange={(e) => setF({ ...f, changeId: e.target.value })}><option value="">None</option>{changes.data?.items.map((c) => <option key={c.id} value={c.id}>{c.ref} · {c.title}</option>)}</select></label>
          <label className="field sd-span-2"><span>Link</span><input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https:// pipeline or release notes" /></label>
          <label className="field sd-span-2"><span>Notes</span><input maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!f.environmentId}>Record</button></div>
      </form>
    </div>
  );
}
