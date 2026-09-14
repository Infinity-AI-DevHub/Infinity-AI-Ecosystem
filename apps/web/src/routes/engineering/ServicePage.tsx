/**
 * One catalogue entry: what it is, who owns it, what it depends on, where its code, docs
 * and APIs live, what is deployed where, its onboarding checklist and its scorecard.
 *
 * The owner and engineering managers can change it; everyone else reads it.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, CircleSlash, ExternalLink, Plus, Trash2, XCircle } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { ServiceStatusBadge, type ServiceStatus } from '../../lib/reliability';
import {
  DeploymentBadge, KIND_LABEL, LIFECYCLE_LABEL, LifecycleBadge, PROTOCOL_LABEL, ScoreBadge, shortSha, TIER_LABEL,
  type Deployment, type DeploymentStatus, type Lifecycle, type Scorecard, type ServiceKind, type Tier,
} from '../../lib/engineering';
import { ApiDialog, type ApiRecord } from './Apis';
import { RecordDeploymentDialog } from './Deployments';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/reliability.css';
import '../../styles/engineering.css';

type Related = { id: string; name: string; status: ServiceStatus; tier: string; note: string | null };
type Environment = { id: string; name: string; kind: string; url: string | null; current: { status: DeploymentStatus; version: string | null; commitSha: string | null; at: string } | null };
export type Entry = {
  id: string; name: string; description: string | null; tier: Tier; kind: ServiceKind; lifecycle: Lifecycle; language: string | null; status: ServiceStatus; isActive: boolean;
  owner: { id: string; name: string } | null; dependsOn: Related[]; dependents: Related[];
  team: { id: string; name: string } | null; project: { id: string; name: string; key: string; openTasks: number } | null;
  links: { id: string; kind: string; title: string; url: string | null; articleId: string | null; articlePublished: boolean | null }[];
  environments: Environment[]; apis: ApiRecord[];
  repositories: { id: string; provider: string; fullName: string; url: string | null; defaultBranch: string | null; lastPushAt: string | null; lastCommitSha: string | null; lastCommitMessage: string | null; lastPusher: string | null; openPullRequests: number }[];
  pullRequests: { id: string; number: number; title: string; author: string | null; url: string | null; openedAt: string; repository: string }[];
  deployments: Deployment[];
  checklist: { id: string; title: string; doneAt: string | null; doneBy: string | null }[];
  scorecard: Scorecard;
  permissions: { canEdit: boolean; canManage: boolean; canRecordDeployment: boolean };
};

const LINK_LABEL: Record<string, string> = { runbook: 'Runbook', docs: 'Docs', dashboard: 'Dashboard', design: 'Design', other: 'Link' };

export default function ServicePage() {
  const { serviceId } = useParams();
  const key = `/engineering/services/${serviceId}`;
  const entry = useQuery<Entry>(serviceId ? key : null, (s) => api.get(key, s));
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [apiEditing, setApiEditing] = useState<ApiRecord | 'new' | null>(null);
  const [recording, setRecording] = useState(false);
  const navigate = useNavigate();
  const [envEditing, setEnvEditing] = useState<string | null>(null);

  if (entry.loading && !entry.data) return <Loading label="Loading service" rows={6} />;
  if (entry.error && !entry.data) {
    return (entry.error as { status?: number }).status === 404
      ? <Empty title="Service not found" action={<Link className="ghost-button" to="/engineering">Catalogue</Link>} />
      : <ErrorState error={entry.error} onRetry={entry.reload} />;
  }
  const s = entry.data!;
  const edit = s.permissions.canEdit;
  const refresh = () => { invalidate('/engineering/'); invalidate('/reliability/'); };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); }
    refresh();
  };

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to="/engineering" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Catalogue</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">{KIND_LABEL[s.kind]} · {TIER_LABEL[s.tier]} tier{s.language ? ` · ${s.language}` : ''}{s.isActive ? '' : ' · retired'}</p>
          <h2>{s.name}</h2>
          <div className="rl-head-meta">
            <LifecycleBadge lifecycle={s.lifecycle} />
            <ServiceStatusBadge status={s.status} />
            <ScoreBadge percent={s.scorecard.percent} level={s.scorecard.level} />
            <span>Owner: {s.owner?.name ?? 'nobody'}</span>
            {s.team ? <Link to={`/engineering?teamId=${s.team.id}`}>Team: {s.team.name}</Link> : null}
            {s.project ? <Link to={`/tasks?projectId=${s.project.id}`}>{s.project.key} · {s.project.openTasks} open {s.project.openTasks === 1 ? 'task' : 'tasks'}</Link> : null}
            <Link to={`/reliability/services/${s.id}`}>Health and alerts</Link>
          </div>
        </div>
        <div className="cc-header-side">
          {s.permissions.canRecordDeployment && s.environments.length ? <button type="button" className="primary-button" onClick={() => setRecording(true)}>Record deployment</button> : null}
          {edit ? <button type="button" className="ghost-button" onClick={() => setEditing(true)}>Edit</button> : null}
          {s.permissions.canManage ? <button type="button" className="ghost-button" onClick={() => { if (window.confirm(`Delete ${s.name} from the catalogue? A service with incident or deployment history can only be retired.`)) void act(async () => { await api.delete(`/reliability/services/${s.id}`); navigate('/engineering'); }); }}>Delete</button> : null}
        </div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      <div className="sd-detail-grid">
        <div className="sd-main">
          <section className="cc-panel" aria-label="About">
            <header><h3>About</h3></header>
            <p className="sd-panel-pad sd-body">{s.description ?? <span className="sd-muted">No description yet.</span>}</p>
          </section>

          <section className="cc-panel" aria-label="Environments">
            <header><h3>Environments</h3>{edit ? <EnvironmentAdd serviceId={s.id} onDone={refresh} onError={setError} /> : null}</header>
            {s.environments.length === 0 ? <p className="cc-empty">No environments. Add production to record deployments.</p> : (
              <div className="eg-envs">
                {s.environments.map((e) => envEditing === e.id ? (
                  <EnvironmentEdit key={e.id} serviceId={s.id} env={e} onDone={() => { setEnvEditing(null); refresh(); }} onError={setError} />
                ) : (
                  <div key={e.id} className="eg-env">
                    <header><strong>{e.name}</strong><span className="cc-meta">{e.kind}</span></header>
                    {e.current ? <><DeploymentBadge status={e.current.status} /><span>{e.current.version ?? shortSha(e.current.commitSha) ?? 'Unversioned'} · {relativeTime(e.current.at)}</span></> : <span className="sd-muted">Nothing deployed yet</span>}
                    <span className="sd-inline">
                      {e.url ? <a href={e.url} target="_blank" rel="noreferrer noopener" className="sd-link-button">Open <ExternalLink size={12} aria-hidden="true" /></a> : null}
                      {edit ? <button type="button" className="sd-link-button" onClick={() => setEnvEditing(e.id)}>Edit</button> : null}
                      {edit && !e.current ? <button type="button" className="sd-link-button" onClick={() => void act(() => api.delete(`/engineering/environments/${e.id}`))}>Remove</button> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="cc-panel" aria-label="Deployments">
            <header><h3>Deployments</h3><Link to={`/engineering/deployments?serviceId=${s.id}`} className="sd-link-button">All</Link></header>
            {s.deployments.length === 0 ? <p className="cc-empty">No deployments recorded. Connect source control, or record one by hand.</p> : (
              <ul className="cc-rows">
                {s.deployments.slice(0, 8).map((d) => (
                  <li key={d.id} className="cc-row">
                    <DeploymentBadge status={d.status} />
                    <span className="cc-row-main">
                      <strong>{d.version ?? shortSha(d.commitSha) ?? 'Unversioned'} → {d.environment.name}</strong>
                      <span>{d.deployedBy ?? 'Unknown'} · {d.source === 'manual' ? 'recorded by hand' : `from ${d.source === 'github' ? 'GitHub' : 'GitLab'}`} · {formatDateTime(d.startedAt)}{d.change ? ` · ${d.change.ref}` : ''}</span>
                    </span>
                    {d.withoutChange ? <span className="cc-tag cc-tag-critical" title="Production release of a critical or high tier service with no change record">No change record</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="cc-panel" aria-label="APIs" id="apis">
            <header><h3>APIs</h3>{edit ? <button type="button" className="sd-link-button" onClick={() => setApiEditing('new')}>Add API</button> : null}</header>
            {s.apis.length === 0 ? <p className="cc-empty">No APIs listed.</p> : (
              <ul className="cc-rows">
                {s.apis.map((a) => (
                  <li key={a.id} className="cc-row">
                    <span className="cc-row-main">
                      <strong>{a.name}{a.version ? ` ${a.version}` : ''}</strong>
                      <span>{PROTOCOL_LABEL[a.protocol]} · {a.visibility} · {a.lifecycle}{a.description ? ` · ${a.description}` : ''}</span>
                    </span>
                    {a.specUrl ? <a className="sd-link-button" href={a.specUrl} target="_blank" rel="noreferrer noopener">Spec</a> : <span className="cc-tag">No spec</span>}
                    {a.docsUrl ? <a className="sd-link-button" href={a.docsUrl} target="_blank" rel="noreferrer noopener">Docs</a> : null}
                    {edit ? <button type="button" className="sd-link-button" onClick={() => setApiEditing(a)}>Edit</button> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="cc-panel" aria-label="Code">
            <header><h3>Code</h3><Link to="/engineering/repositories" className="sd-link-button">{s.permissions.canManage ? 'Link a repository' : 'Repositories'}</Link></header>
            {s.repositories.length === 0 ? <p className="cc-empty">No repository linked.</p> : (
              <ul className="cc-rows">
                {s.repositories.map((r) => (
                  <li key={r.id} className="cc-row">
                    <span className="cc-row-main">
                      <strong>{r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.fullName}</a> : r.fullName}</strong>
                      <span>{r.lastPushAt ? <>{r.defaultBranch ?? 'default branch'}: <span className="eg-mono">{shortSha(r.lastCommitSha)}</span> {r.lastCommitMessage} · {r.lastPusher ?? 'someone'} · {relativeTime(r.lastPushAt)}</> : 'No pushes received yet'}</span>
                    </span>
                    <span className="cc-meta">{r.openPullRequests} open</span>
                  </li>
                ))}
              </ul>
            )}
            {s.pullRequests.length ? (
              <>
                <h4 className="sd-subhead sd-panel-pad">Open pull requests</h4>
                <ul className="cc-rows">
                  {s.pullRequests.map((p) => (
                    <li key={p.id} className="cc-row">
                      <span className="cc-row-main"><strong>{p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener">#{p.number} {p.title}</a> : `#${p.number} ${p.title}`}</strong><span>{p.repository} · {p.author ?? 'unknown'} · opened {relativeTime(p.openedAt)}</span></span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </div>

        <aside className="sd-side">
          <ScorecardPanel scorecard={s.scorecard} />

          <section className="cc-panel" aria-label="Runbooks and docs">
            <header><h3>Runbooks and docs</h3></header>
            {s.links.length === 0 ? <p className="cc-empty">Nothing linked.</p> : (
              <ul className="cc-rows">
                {s.links.map((l) => (
                  <li key={l.id} className="sd-link-row">
                    <span className="cc-row">
                      <span className="cc-row-main">
                        <strong>{l.articleId ? <Link to={`/service/knowledge/${l.articleId}`}>{l.title}</Link> : <a href={l.url!} target="_blank" rel="noreferrer noopener">{l.title}</a>}</strong>
                        <span>{LINK_LABEL[l.kind]}{l.articleId ? ` · knowledge base${l.articlePublished ? '' : ' (not published)'}` : ''}</span>
                      </span>
                    </span>
                    {edit ? <button type="button" className="icon-button" aria-label={`Remove ${l.title}`} onClick={() => void act(() => api.delete(`/engineering/links/${l.id}`))}><Trash2 size={14} /></button> : null}
                  </li>
                ))}
              </ul>
            )}
            {edit ? <LinkAdd serviceId={s.id} onDone={refresh} onError={setError} /> : null}
          </section>

          <section className="cc-panel" aria-label="Dependencies">
            <header><h3>Dependencies</h3></header>
            <h4 className="sd-subhead sd-panel-pad">Depends on</h4>
            {s.dependsOn.length === 0 ? <p className="cc-empty">Nothing recorded.</p> : (
              <ul className="cc-rows">
                {s.dependsOn.map((d) => (
                  <li key={d.id} className="sd-link-row">
                    <Link to={`/engineering/services/${d.id}`} className="cc-row"><span className="cc-row-main"><strong>{d.name}</strong>{d.note ? <span>{d.note}</span> : null}</span><ServiceStatusBadge status={d.status} /></Link>
                    {edit ? <button type="button" className="icon-button" aria-label={`Remove dependency on ${d.name}`} onClick={() => void act(() => api.delete(`/engineering/services/${s.id}/dependencies/${d.id}`))}><Trash2 size={14} /></button> : null}
                  </li>
                ))}
              </ul>
            )}
            {edit ? <DependencyAdd entry={s} onDone={refresh} onError={setError} /> : null}
            <h4 className="sd-subhead sd-panel-pad">Used by</h4>
            {s.dependents.length === 0 ? <p className="cc-empty">Nothing depends on it.</p> : (
              <ul className="cc-rows">
                {s.dependents.map((d) => <li key={d.id}><Link to={`/engineering/services/${d.id}`} className="cc-row"><span className="cc-row-main"><strong>{d.name}</strong><span>{d.tier} tier</span></span><ServiceStatusBadge status={d.status} /></Link></li>)}
              </ul>
            )}
          </section>

          <section className="cc-panel" aria-label="Onboarding checklist">
            <header><h3>Onboarding</h3><span className="cc-meta">{s.checklist.filter((c) => c.doneAt).length}/{s.checklist.length}</span></header>
            {s.checklist.length === 0 ? <p className="cc-empty">No checklist.</p> : s.checklist.map((c) => (
              <label key={c.id} className={`eg-check ${c.doneAt ? 'is-done' : ''}`}>
                <input type="checkbox" checked={Boolean(c.doneAt)} disabled={!edit} onChange={(e) => void act(() => api.patch(`/engineering/checklist/${c.id}`, { done: e.target.checked }))} />
                <span title={c.doneAt ? `Done by ${c.doneBy ?? 'someone'} ${relativeTime(c.doneAt)}` : undefined}>{c.title}</span>
                {edit ? <button type="button" className="sd-link-button" aria-label={`Remove ${c.title}`} onClick={(e) => { e.preventDefault(); void act(() => api.patch(`/engineering/checklist/${c.id}`, { remove: true })); }}>Remove</button> : null}
              </label>
            ))}
            {edit ? <ChecklistAdd serviceId={s.id} onDone={refresh} onError={setError} /> : null}
          </section>
        </aside>
      </div>

      {editing ? <EditDialog entry={s} onClose={() => { setEditing(false); refresh(); }} /> : null}
      {apiEditing ? <ApiDialog serviceId={s.id} api={apiEditing === 'new' ? null : apiEditing} onClose={() => { setApiEditing(null); refresh(); }} /> : null}
      {recording ? <RecordDeploymentDialog serviceId={s.id} environments={s.environments} onClose={() => { setRecording(false); refresh(); }} /> : null}
    </div>
  );
}

export function ScorecardPanel({ scorecard }: { scorecard: Scorecard }) {
  return (
    <section className="cc-panel" aria-label="Scorecard">
      <header><h3>Scorecard</h3><ScoreBadge percent={scorecard.percent} level={scorecard.level} /></header>
      <ul className="eg-rules">
        {scorecard.rules.map((r) => (
          <li key={r.id} className={r.applies ? '' : 'is-na'}>
            {!r.applies ? <CircleSlash size={16} aria-label="Does not apply" /> : r.passed ? <CheckCircle2 size={16} className="eg-pass" aria-label="Passing" /> : <XCircle size={16} className="eg-fail" aria-label="Failing" />}
            <span>{r.label}{r.applies && !r.passed ? <span className="field-hint">{r.hint}</span> : null}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EditDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const people = useQuery<Paged<{ id: string; displayName: string }>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const teams = useQuery<{ items: { id: string; name: string }[] }>('/engineering/teams', (s) => api.get('/engineering/teams', s));
  const projects = useQuery<{ items: { id: string; name: string; key: string; status: string }[] }>('/projects', (s) => api.get('/projects', s));
  const [f, setF] = useState({ description: entry.description ?? '', tier: entry.tier, kind: entry.kind, lifecycle: entry.lifecycle, language: entry.language ?? '', ownerUserId: entry.owner?.id ?? '', teamGroupId: entry.team?.id ?? '', projectId: entry.project?.id ?? '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-svc-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { await api.patch(`/engineering/services/${entry.id}`, { ...f, description: f.description || null, language: f.language || null, ownerUserId: f.ownerUserId || null, teamGroupId: f.teamGroupId || null, projectId: f.projectId || null }); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'Not saved.'); }
        }}>
        <h3 id="edit-svc-title">Edit {entry.name}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>What it does</span><textarea autoFocus rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={5000} /></label>
          <label className="field"><span>Kind</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ServiceKind })}>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Tier</span><select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value as Tier })}>{Object.entries(TIER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Lifecycle</span><select value={f.lifecycle} onChange={(e) => setF({ ...f, lifecycle: e.target.value as Lifecycle })}>{Object.entries(LIFECYCLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Main language</span><input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} maxLength={40} /></label>
          <label className="field sd-span-2"><span>Owner</span><select value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })}><option value="">Nobody</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field"><span>Team</span><select value={f.teamGroupId} onChange={(e) => setF({ ...f, teamGroupId: e.target.value })}><option value="">No team</option>{teams.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label className="field"><span>Project</span><select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">No project</option>{projects.data?.items.filter((p) => p.status !== 'archived' || p.id === f.projectId).map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</select></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save</button></div>
      </form>
    </div>
  );
}

function EnvironmentAdd({ serviceId, onDone, onError }: { serviceId: string; onDone: () => void; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', kind: 'production', url: '' });
  if (!open) return <button type="button" className="sd-link-button" onClick={() => setOpen(true)}>Add environment</button>;
  return (
    <form className="sd-inline" onSubmit={async (e) => {
      e.preventDefault(); onError(null);
      try { await api.post(`/engineering/services/${serviceId}/environments`, { ...f, url: f.url || null }); setOpen(false); setF({ name: '', kind: 'production', url: '' }); }
      catch (err) { onError(err instanceof ApiError ? err.message : 'Not added.'); }
      onDone();
    }}>
      <input aria-label="Environment name" autoFocus required maxLength={60} placeholder="production" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select aria-label="Environment kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="production">Production</option><option value="staging">Staging</option><option value="development">Development</option><option value="other">Other</option></select>
      <input aria-label="Environment address" type="url" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      <button type="submit" className="ghost-button">Add</button>
      <button type="button" className="sd-link-button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

function EnvironmentEdit({ serviceId, env, onDone, onError }: { serviceId: string; env: Environment; onDone: () => void; onError: (m: string | null) => void }) {
  const [f, setF] = useState({ name: env.name, kind: env.kind, url: env.url ?? '' });
  return (
    <form className="eg-env" aria-label={`Edit ${env.name}`} onSubmit={async (e) => {
      e.preventDefault(); onError(null);
      try { await api.put(`/engineering/services/${serviceId}/environments/${env.id}`, { ...f, url: f.url || null }); onDone(); }
      catch (err) { onError(err instanceof ApiError ? err.message : 'Not saved.'); }
    }}>
      <input aria-label="Environment name" autoFocus required maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select aria-label="Environment kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="production">Production</option><option value="staging">Staging</option><option value="development">Development</option><option value="other">Other</option></select>
      <input aria-label="Environment address" type="url" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      <span className="sd-inline"><button type="submit" className="ghost-button">Save</button><button type="button" className="sd-link-button" onClick={onDone}>Cancel</button></span>
    </form>
  );
}

function LinkAdd({ serviceId, onDone, onError }: { serviceId: string; onDone: () => void; onError: (m: string | null) => void }) {
  const [f, setF] = useState({ kind: 'runbook', title: '', target: 'url' as 'url' | 'article', url: '', articleId: '' });
  const [q, setQ] = useState('');
  const articleKey = f.target === 'article' ? `/service/knowledge?limit=20${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}` : null;
  const articles = useQuery<{ items: { id: string; title: string; status: string }[] }>(articleKey, (s) => api.get(articleKey!, s));
  return (
    <form className="sd-panel-pad sd-editor" aria-label="Add a runbook or document" onSubmit={async (e) => {
      e.preventDefault(); onError(null);
      try {
        await api.post(`/engineering/services/${serviceId}/links`, { kind: f.kind, title: f.title, url: f.target === 'url' ? f.url : null, articleId: f.target === 'article' ? f.articleId : null });
        setF({ ...f, title: '', url: '', articleId: '' });
      } catch (err) { onError(err instanceof ApiError ? err.message : 'Not added.'); }
      onDone();
    }}>
      <div className="sd-inline">
        <select aria-label="Link kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(LINK_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select aria-label="Link to" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value as 'url' | 'article' })}><option value="url">Web address</option><option value="article">Knowledge base article</option></select>
      </div>
      {f.target === 'url'
        ? <input aria-label="Link address" type="url" required placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
        : (
          <div className="sd-inline">
            <input type="search" aria-label="Find an article" placeholder="Find an article" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Article" required value={f.articleId} onChange={(e) => { const a = articles.data?.items.find((x) => x.id === e.target.value); setF({ ...f, articleId: e.target.value, title: f.title || a?.title || '' }); }}>
              <option value="">Choose…</option>
              {articles.data?.items.map((a) => <option key={a.id} value={a.id}>{a.title}{a.status !== 'published' ? ` (${a.status})` : ''}</option>)}
            </select>
          </div>
        )}
      <div className="sd-inline">
        <input aria-label="Link title" required minLength={2} maxLength={200} placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <button type="submit" className="ghost-button"><Plus size={14} aria-hidden="true" /> Add</button>
      </div>
    </form>
  );
}

function DependencyAdd({ entry, onDone, onError }: { entry: Entry; onDone: () => void; onError: (m: string | null) => void }) {
  const list = useQuery<{ items: { id: string; name: string }[] }>('/engineering/services', (s) => api.get('/engineering/services', s));
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const options = (list.data?.items ?? []).filter((x) => x.id !== entry.id && !entry.dependsOn.some((d) => d.id === x.id));
  return (
    <form className="sd-panel-pad sd-editor" aria-label="Add a dependency" onSubmit={async (e) => {
      e.preventDefault(); onError(null);
      try { await api.post(`/engineering/services/${entry.id}/dependencies`, { dependsOnId: target, note: note || null }); setTarget(''); setNote(''); }
      catch (err) { onError(err instanceof ApiError ? err.message : 'Not added.'); }
      onDone();
    }}>
      <div className="sd-inline">
        <select aria-label="Depends on" required value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Depends on…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      </div>
      <div className="sd-inline">
        <input aria-label="What for" maxLength={200} placeholder="What for (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" className="ghost-button" disabled={!target}>Add</button>
      </div>
    </form>
  );
}

function ChecklistAdd({ serviceId, onDone, onError }: { serviceId: string; onDone: () => void; onError: (m: string | null) => void }) {
  const [title, setTitle] = useState('');
  return (
    <form className="sd-panel-pad sd-inline" aria-label="Add a checklist step" onSubmit={async (e) => {
      e.preventDefault(); onError(null);
      try { await api.post(`/engineering/services/${serviceId}/checklist`, { title }); setTitle(''); }
      catch (err) { onError(err instanceof ApiError ? err.message : 'Not added.'); }
      onDone();
    }}>
      <input aria-label="New step" required minLength={2} maxLength={200} placeholder="Add a step" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button type="submit" className="ghost-button">Add</button>
    </form>
  );
}
