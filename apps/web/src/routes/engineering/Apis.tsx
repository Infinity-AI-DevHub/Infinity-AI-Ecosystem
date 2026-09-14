/**
 * The API catalogue: every interface a service exposes, its version, audience, lifecycle and
 * where its spec lives. Entries are edited from their service, by its owner or a manager.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { PROTOCOL_LABEL } from '../../lib/engineering';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/engineering.css';

export type ApiRecord = { id: string; name: string; protocol: string; version: string | null; lifecycle: string; visibility: string; description: string | null; specUrl: string | null; docsUrl: string | null };
type ApiListItem = ApiRecord & { service: { id: string; name: string }; ownerName: string | null; updatedAt: string };

const LIFECYCLES = ['draft', 'active', 'deprecated', 'retired'];
const VISIBILITIES = ['internal', 'partner', 'public'];

export default function Apis() {
  const [q, setQ] = useState('');
  const [protocol, setProtocol] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [visibility, setVisibility] = useState('');
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (protocol) params.set('protocol', protocol);
  if (lifecycle) params.set('lifecycle', lifecycle);
  if (visibility) params.set('visibility', visibility);
  const key = `/engineering/apis?${params}`;
  const list = useQuery<{ items: ApiListItem[] }>(key, (s) => api.get(key, s));
  const filtered = Boolean(q || protocol || lifecycle || visibility);
  return (
    <div className="module-page cc-page">
      <header className="cc-header"><div><p className="cc-eyebrow">Engineering</p><h2>API catalogue</h2></div></header>
      <div className="sd-toolbar">
        <div className="sd-filters">
          <input type="search" aria-label="Search APIs" placeholder="Search APIs or services" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}><option value="">All protocols</option>{Object.entries(PROTOCOL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select aria-label="Lifecycle" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}><option value="">Any lifecycle</option>{LIFECYCLES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <select aria-label="Audience" value={visibility} onChange={(e) => setVisibility(e.target.value)}><option value="">Any audience</option>{VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        </div>
      </div>
      {list.loading && !list.data ? <Loading rows={5} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title={filtered ? 'No APIs match' : 'No APIs listed'} description={filtered ? 'Try fewer filters.' : 'Add APIs from the service that exposes them, on its catalogue page.'} />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">API</th><th scope="col">Service</th><th scope="col">Protocol</th><th scope="col">Audience</th><th scope="col">Lifecycle</th><th scope="col">Spec</th></tr></thead>
              <tbody>
                {list.data!.items.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{a.name}{a.version ? ` ${a.version}` : ''}<span className="sd-sub">{a.description ?? `Updated ${relativeTime(a.updatedAt)}`}</span></th>
                    <td><Link to={`/engineering/services/${a.service.id}`}>{a.service.name}</Link><span className="sd-sub">{a.ownerName ?? 'No owner'}</span></td>
                    <td>{PROTOCOL_LABEL[a.protocol]}</td>
                    <td>{a.visibility}</td>
                    <td><span className={`cc-tag ${a.lifecycle === 'deprecated' ? 'cc-tag-critical' : a.lifecycle === 'active' ? 'cc-tag-info' : ''}`}>{a.lifecycle}</span></td>
                    <td>{a.specUrl ? <a href={a.specUrl} target="_blank" rel="noreferrer noopener">Spec</a> : <span className="sd-muted">Missing</span>}{a.docsUrl ? <> · <a href={a.docsUrl} target="_blank" rel="noreferrer noopener">Docs</a></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

export function ApiDialog({ serviceId, api: record, onClose }: { serviceId: string; api: ApiRecord | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: record?.name ?? '', protocol: record?.protocol ?? 'rest', version: record?.version ?? '', lifecycle: record?.lifecycle ?? 'active',
    visibility: record?.visibility ?? 'internal', description: record?.description ?? '', specUrl: record?.specUrl ?? '', docsUrl: record?.docsUrl ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="api-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { ...f, version: f.version || null, description: f.description || null, specUrl: f.specUrl || null, docsUrl: f.docsUrl || null };
          try {
            if (record) await api.put(`/engineering/services/${serviceId}/apis/${record.id}`, body);
            else await api.post(`/engineering/services/${serviceId}/apis`, body);
            onClose();
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The API was not saved.'); }
        }}>
        <h3 id="api-title">{record ? `Edit ${record.name}` : 'Add an API'}</h3>
        <div className="sd-form-grid">
          <label className="field"><span>Name</span><input autoFocus required minLength={2} maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Payments API" /></label>
          <label className="field"><span>Version</span><input maxLength={40} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="v2" /></label>
          <label className="field"><span>Protocol</span><select value={f.protocol} onChange={(e) => setF({ ...f, protocol: e.target.value })}>{Object.entries(PROTOCOL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Audience</span><select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}>{VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
          <label className="field"><span>Lifecycle</span><select value={f.lifecycle} onChange={(e) => setF({ ...f, lifecycle: e.target.value })}>{LIFECYCLES.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
          <span />
          <label className="field sd-span-2"><span>Spec link</span><input type="url" value={f.specUrl} onChange={(e) => setF({ ...f, specUrl: e.target.value })} placeholder="https://…/openapi.json" /></label>
          <label className="field sd-span-2"><span>Docs link</span><input type="url" value={f.docsUrl} onChange={(e) => setF({ ...f, docsUrl: e.target.value })} placeholder="https://" /></label>
          <label className="field sd-span-2"><span>Description</span><textarea rows={2} maxLength={5000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {record ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Remove ${record.name} from the catalogue?`)) return;
            try { await api.delete(`/engineering/apis/${record.id}`); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not removed.'); }
          }}>Remove</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button">Save</button>
        </div>
      </form>
    </div>
  );
}
