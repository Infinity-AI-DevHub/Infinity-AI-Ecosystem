/**
 * The software catalogue: every service, website, job and library, who owns it, how healthy
 * its engineering baseline is and when it last shipped.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { ServiceStatusBadge, type ServiceStatus } from '../../lib/reliability';
import { DeploymentBadge, KIND_LABEL, LIFECYCLE_LABEL, LifecycleBadge, ScoreBadge, TIER_LABEL, type CatalogueItem, type Lifecycle, type ServiceKind, type Tier } from '../../lib/engineering';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/reliability.css';
import '../../styles/engineering.css';

type Template = { id: string; name: string; description: string | null; kind: ServiceKind; tier: Tier; checklist: string[]; environments: string[] };
type Person = { id: string; displayName: string };

export default function Catalogue() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useSearchParams();
  const teamId = search.get('teamId') ?? '';
  const teams = useQuery<{ items: { id: string; name: string }[] }>('/engineering/teams', (s) => api.get('/engineering/teams', s));
  const params = new URLSearchParams();
  if (teamId) params.set('teamId', teamId);
  if (q.trim()) params.set('q', q.trim());
  if (kind) params.set('kind', kind);
  if (lifecycle) params.set('lifecycle', lifecycle);
  if (mine) params.set('mine', 'true');
  const key = `/engineering/services?${params}`;
  const list = useQuery<{ items: CatalogueItem[] }>(key, (s) => api.get(key, s));
  const [creating, setCreating] = useState(false);

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Engineering</p><h2>Software catalogue</h2></div>
        <div className="cc-header-side">{can('engineering.manage') ? <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> New service</button> : null}</div>
      </header>
      <div className="sd-toolbar">
        <div className="sd-filters">
          <input type="search" aria-label="Search the catalogue" placeholder="Search name, description, language" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select aria-label="Lifecycle" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}><option value="">Any lifecycle</option>{Object.entries(LIFECYCLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select aria-label="Team" value={teamId} onChange={(e) => { const next = new URLSearchParams(search); if (e.target.value) next.set('teamId', e.target.value); else next.delete('teamId'); setSearch(next, { replace: true }); }}><option value="">All teams</option>{teams.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label className="sd-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Owned by me</label>
        </div>
      </div>
      {list.loading && !list.data ? <Loading label="Loading the catalogue" rows={6} />
        : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title={q || kind || lifecycle || mine || teamId ? 'Nothing matches' : 'The catalogue is empty'} description={q || kind || lifecycle || mine || teamId ? 'Try fewer filters.' : 'Add the software the company runs, with an owner, its code and its runbooks.'} />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Service</th><th scope="col">Owner</th><th scope="col">Lifecycle</th><th scope="col">Health</th><th scope="col">Last deployment</th><th scope="col">Code</th><th scope="col">Scorecard</th></tr></thead>
              <tbody>
                {list.data!.items.map((s) => (
                  <tr key={s.id} className="sd-row" onClick={() => navigate(`/engineering/services/${s.id}`)}>
                    <th scope="row">
                      <Link to={`/engineering/services/${s.id}`} className="sd-subject" onClick={(e) => e.stopPropagation()}><span>{s.name}</span></Link>
                      <span className="sd-sub">{KIND_LABEL[s.kind]} · {TIER_LABEL[s.tier]} tier{s.language ? ` · ${s.language}` : ''}</span>
                    </th>
                    <td>{s.owner?.name ?? <span className="sd-muted">No owner</span>}{s.team?.name ? <span className="sd-sub">{s.team.name}</span> : null}</td>
                    <td><LifecycleBadge lifecycle={s.lifecycle} /></td>
                    <td><ServiceStatusBadge status={s.status as ServiceStatus} /></td>
                    <td>{s.lastDeployment ? <><DeploymentBadge status={s.lastDeployment.status} /><span className="sd-sub">{s.lastDeployment.environment} · {relativeTime(s.lastDeployment.at)}</span></> : <span className="sd-muted">None recorded</span>}</td>
                    <td>{s.repositories ? `${s.repositories} ${s.repositories === 1 ? 'repo' : 'repos'}` : <span className="sd-muted">Not linked</span>}{s.openPullRequests ? <span className="sd-sub">{s.openPullRequests} open pull {s.openPullRequests === 1 ? 'request' : 'requests'}</span> : null}</td>
                    <td><ScoreBadge percent={s.score.percent} level={s.score.level} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {creating ? <NewServiceDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); invalidate('/engineering/'); navigate(`/engineering/services/${id}`); }} /> : null}
    </div>
  );
}

export function NewServiceDialog({ templateId, onClose, onCreated }: { templateId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const templates = useQuery<{ items: Template[] }>('/engineering/templates', (s) => api.get('/engineering/templates', s));
  const people = useQuery<Paged<Person>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const [f, setF] = useState({ name: '', description: '', templateId: templateId ?? '', kind: '' as ServiceKind | '', tier: '' as Tier | '', lifecycle: 'experimental' as Lifecycle, language: '', ownerUserId: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tpl = templates.data?.items.find((t) => t.id === f.templateId);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="new-svc-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null); setSaving(true);
          try {
            const res = await api.post<{ id: string }>('/engineering/services', {
              name: f.name, description: f.description || null, templateId: f.templateId || null, kind: f.kind || undefined, tier: f.tier || undefined,
              lifecycle: f.lifecycle, language: f.language || null, ownerUserId: f.ownerUserId || null,
            });
            onCreated(res.id);
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The service was not created.'); } finally { setSaving(false); }
        }}>
        <h3 id="new-svc-title">New service</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Template</span>
            <select value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
              <option value="">No template</option>
              {templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {tpl ? <p className="field-hint sd-span-2">{tpl.description ? `${tpl.description} · ` : ''}Adds {tpl.checklist.length} onboarding {tpl.checklist.length === 1 ? 'step' : 'steps'}{tpl.environments.length ? ` and the ${tpl.environments.join(', ')} ${tpl.environments.length === 1 ? 'environment' : 'environments'}` : ''}.</p> : null}
          <label className="field sd-span-2"><span>Name</span><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={160} placeholder="Payments API" /></label>
          <label className="field sd-span-2"><span>What it does</span><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={5000} /></label>
          <label className="field"><span>Kind</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ServiceKind })}><option value="">{tpl ? `From template (${KIND_LABEL[tpl.kind]})` : 'Service'}</option>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Tier</span><select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value as Tier })}><option value="">{tpl ? `From template (${TIER_LABEL[tpl.tier]})` : 'Standard'}</option>{Object.entries(TIER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Lifecycle</span><select value={f.lifecycle} onChange={(e) => setF({ ...f, lifecycle: e.target.value as Lifecycle })}>{Object.entries(LIFECYCLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Main language</span><input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} maxLength={40} placeholder="TypeScript" /></label>
          <label className="field sd-span-2"><span>Owner</span><select value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })}><option value="">Nobody yet</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={saving}>{saving ? 'Creating…' : 'Create service'}</button></div>
      </form>
    </div>
  );
}
