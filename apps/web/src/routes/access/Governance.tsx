/**
 * Access governance for owners, administrators and auditors: the work queue of access to
 * set up or take away, every grant, the systems catalogue, reviews and offboarding.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { GRANT_LABEL, REASON_LABEL, RiskTag, type Grant, type Resource } from './MyAccess';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/academy.css';

type Person = { id: string; displayName: string };

export function Grants() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') ?? 'todo') as 'todo' | 'all';
  const key = `/access/grants?view=${view}`;
  const list = useQuery<{ items: Grant[] }>(key, (s) => api.get(key, s));
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); } invalidate('/access/'); };
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Access</p><h2>Grants</h2></div>
        <div className="cc-header-side">{can('access.manage') ? <button type="button" className="ghost-button" onClick={() => setRecording(true)}><Plus size={15} aria-hidden="true" /> Record existing access</button> : null}</div>
      </header>
      <div className="tab-row" role="tablist" aria-label="Grant views">
        {([['todo', 'To set up or remove'], ['all', 'All access']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={`tab ${view === id ? 'tab-active' : ''}`} onClick={() => setParams({ view: id }, { replace: true })}>{label}</button>
        ))}
      </div>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {list.loading && !list.data ? <Loading rows={4} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title={view === 'todo' ? 'Nothing to do' : 'No access recorded'} description={view === 'todo' ? 'Approved access to set up and access to take away appear here for the systems you own.' : 'Grants appear as requests are approved or existing access is recorded.'} />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Person</th><th scope="col">System</th><th scope="col">State</th><th scope="col">Ends</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>{list.data!.items.map((g) => (
                <tr key={g.id}>
                  <th scope="row">{g.user.name}<span className="sd-sub">{g.user.status !== 'active' ? g.user.status : g.requestRef ?? (g.source === 'manual' ? 'Recorded' : '')}</span></th>
                  <td>{g.resource.name} · {g.role}<span className="sd-sub">{g.resource.risk} risk</span></td>
                  <td>{GRANT_LABEL[g.status]}<span className="sd-sub">{g.removalReason ? REASON_LABEL[g.removalReason] : g.provisionedBy ? `set up by ${g.provisionedBy}` : `approved ${relativeTime(g.createdAt)}`}{g.removalNote ? ` · ${g.removalNote}` : ''}</span></td>
                  <td>{g.expiresAt ? formatDate(g.expiresAt) : g.status === 'pending_grant' ? 'Starts when set up' : '—'}</td>
                  <td>
                    {g.canAct && g.status === 'pending_grant' ? <button type="button" className="primary-button" onClick={() => void act(() => api.post(`/access/grants/${g.id}/confirm`, {}))}>Confirm set up</button> : null}
                    {g.canAct && g.status === 'pending_removal' ? <button type="button" className="primary-button" onClick={() => void act(() => api.post(`/access/grants/${g.id}/removed`, {}))}>Confirm removed</button> : null}
                    {g.canAct && (g.status === 'active' || g.status === 'pending_grant') ? <button type="button" className="sd-link-button" onClick={() => { const note = window.prompt(`Why remove ${g.user.name}'s ${g.resource.name} access?`); if (note && note.trim().length >= 3) void act(() => api.post(`/access/grants/${g.id}/revoke`, { note })); }}>Revoke</button> : null}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      {recording ? <RecordGrantDialog onClose={() => { setRecording(false); invalidate('/access/'); }} /> : null}
    </div>
  );
}

function RecordGrantDialog({ onClose }: { onClose: () => void }) {
  const resources = useQuery<{ items: Resource[] }>('/access/resources', (s) => api.get('/access/resources', s));
  const people = useQuery<Paged<Person>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const [f, setF] = useState({ resourceId: '', role: '', userId: '', expiresAt: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const r = resources.data?.items.find((x) => x.id === f.resourceId);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="rec-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { await api.post('/access/grants', { resourceId: f.resourceId, role: f.role, userId: f.userId, expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59`).toISOString() : null, note: f.note || null }); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'Not recorded.'); }
        }}>
        <h3 id="rec-title">Record existing access</h3>
        <p className="field-hint">For access people already had before it was governed here, so it can be reviewed.</p>
        <div className="sd-form-grid">
          <label className="field"><span>System</span><select autoFocus required value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value, role: resources.data?.items.find((x) => x.id === e.target.value)?.roles[0] ?? '' })}><option value="">Choose…</option>{resources.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label className="field"><span>Role</span><select required value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{r?.roles.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
          <label className="field"><span>Person</span><select required value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Choose…</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field"><span>Ends</span><input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
          <label className="field sd-span-2"><span>Note</span><input maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Record</button></div>
      </form>
    </div>
  );
}

export function Systems() {
  const { can } = useSession();
  const manage = can('access.manage');
  const key = `/access/resources${manage ? '?includeInactive=true' : ''}`;
  const list = useQuery<{ items: Resource[] }>(key, (s) => api.get(key, s));
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Access</p><h2>Systems</h2></div>
        <div className="cc-header-side">{manage ? <button type="button" className="primary-button" onClick={() => setEditing('new')}><Plus size={15} aria-hidden="true" /> Add system</button> : null}</div>
      </header>
      {list.loading && !list.data ? <Loading rows={4} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No systems in the catalogue" description={manage ? 'Add the applications, infrastructure and data people ask for access to.' : 'An administrator adds systems.'} />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">System</th><th scope="col">Owner</th><th scope="col">Roles</th><th scope="col">Rules</th><th scope="col">Active grants</th></tr></thead>
              <tbody>{list.data!.items.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{manage ? <button type="button" className="sd-link-button" onClick={() => setEditing(r)}>{r.name}</button> : r.name}<span className="sd-sub">{r.kind}{r.service ? ` · ${r.service.name}` : ''}{r.isActive ? '' : ' · retired'}</span></th>
                  <td>{r.owner?.name ?? <span className="sd-muted">Administrators</span>}</td>
                  <td>{r.roles.join(', ')}</td>
                  <td><RiskTag risk={r.risk} /><span className="sd-sub">{r.maxDays ? `Temporary, up to ${r.maxDays} days` : 'Permanent allowed'}{r.requiredCourse ? ` · needs ${r.requiredCourse.title}` : ''}</span></td>
                  <td>{r.activeGrants ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      {editing ? <SystemDialog resource={editing === 'new' ? null : editing} onClose={() => { setEditing(null); invalidate('/access/'); }} /> : null}
    </div>
  );
}

function SystemDialog({ resource, onClose }: { resource: Resource | null; onClose: () => void }) {
  const people = useQuery<Paged<Person>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const services = useQuery<{ items: { id: string; name: string }[] }>('/engineering/services', (s) => api.get('/engineering/services', s));
  const courses = useQuery<{ items: { id: string; title: string; status: string }[] }>('/academy/courses?status=published', (s) => api.get('/academy/courses?status=published', s));
  const [f, setF] = useState({
    name: resource?.name ?? '', description: resource?.description ?? '', kind: resource?.kind ?? 'application', roles: (resource?.roles ?? ['Viewer', 'Admin']).join(', '),
    risk: resource?.risk ?? 'medium', ownerId: resource?.owner?.id ?? '', serviceId: resource?.service?.id ?? '', maxDays: resource?.maxDays ?? '' as number | '',
    requiredCourseId: resource?.requiredCourse?.id ?? '', isActive: resource?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="sys-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { ...f, description: f.description || null, roles: f.roles.split(','), ownerId: f.ownerId || null, serviceId: f.serviceId || null, maxDays: f.maxDays === '' ? null : Number(f.maxDays), requiredCourseId: f.requiredCourseId || null };
          try { if (resource) await api.put(`/access/resources/${resource.id}`, body); else await api.post('/access/resources', body); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'Not saved.'); }
        }}>
        <h3 id="sys-title">{resource ? `Edit ${resource.name}` : 'Add a system'}</h3>
        <div className="sd-form-grid">
          <label className="field"><span>Name</span><input autoFocus required minLength={2} maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="AWS production account" /></label>
          <label className="field"><span>Kind</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['application', 'infrastructure', 'data', 'physical', 'other'].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label className="field sd-span-2"><span>Description</span><input maxLength={1000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label className="field sd-span-2"><span>Roles (comma separated)</span><input required value={f.roles} onChange={(e) => setF({ ...f, roles: e.target.value })} /></label>
          <label className="field"><span>Owner (approves and sets up)</span><select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">Administrators</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field"><span>Risk</span><select value={f.risk} onChange={(e) => setF({ ...f, risk: e.target.value as Resource['risk'] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High: an administrator also approves</option></select></label>
          <label className="field"><span>Longest grant (days)</span><input type="number" min={1} max={365} value={f.maxDays} placeholder="Empty allows permanent" onChange={(e) => setF({ ...f, maxDays: e.target.value === '' ? '' : Number(e.target.value) })} /></label>
          <label className="field"><span>Required course</span><select value={f.requiredCourseId} onChange={(e) => setF({ ...f, requiredCourseId: e.target.value })}><option value="">None</option>{courses.data?.items.filter((c) => c.status === 'published').map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
          <label className="field"><span>Service</span><select value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}><option value="">None</option>{services.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          {resource ? <label className="sd-check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In the catalogue</label> : null}
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {resource ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete ${resource.name}? A system with access history can only be taken out of the catalogue.`)) return;
            try { await api.delete(`/access/resources/${resource.id}`); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save</button></div>
      </form>
    </div>
  );
}

type ReviewSummary = { id: string; name: string; scope: string; dueAt: string; status: string; total: number; decided: number; revoked: number; mine: number; mineOpen: number; overdue: boolean };

export function Reviews() {
  const { can } = useSession();
  const navigate = useNavigate();
  const list = useQuery<{ items: ReviewSummary[] }>('/access/reviews', (s) => api.get('/access/reviews', s));
  const [creating, setCreating] = useState(false);
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Access</p><h2>Access reviews</h2></div>
        <div className="cc-header-side">{can('access.manage') ? <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> Start a review</button> : null}</div>
      </header>
      {list.loading && !list.data ? <Loading rows={3} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No reviews" description="A review asks each system owner to confirm who still needs access." />
        : (
          <ul className="cc-panel cc-rows">{list.data!.items.map((v) => (
            <li key={v.id}><Link to={`/access/reviews/${v.id}`} className="cc-row">
              <span className="cc-row-main"><strong>{v.name}</strong><span>{v.scope} · {v.decided}/{v.total} decided · {v.revoked} revoked · due {formatDate(v.dueAt)}{v.mineOpen ? ` · ${v.mineOpen} waiting on you` : ''}</span></span>
              <span className={`cc-tag ${v.overdue ? 'cc-tag-critical' : v.status === 'closed' ? '' : 'cc-tag-info'}`}>{v.overdue ? 'Overdue' : v.status}</span>
            </Link></li>
          ))}</ul>
        )}
      {creating ? <ReviewDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); invalidate('/access/'); navigate(`/access/reviews/${id}`); }} /> : null}
    </div>
  );
}

function ReviewDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const resources = useQuery<{ items: Resource[] }>('/access/resources', (s) => api.get('/access/resources', s));
  const [f, setF] = useState({ name: '', resourceId: '', dueAt: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="rev-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { const res = await api.post<{ id: string }>('/access/reviews', { name: f.name, resourceId: f.resourceId || null, dueAt: new Date(`${f.dueAt}T17:00`).toISOString() }); onCreated(res.id); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'The review was not started.'); }
        }}>
        <h3 id="rev-title">Start an access review</h3>
        <p className="field-hint">Every active grant in scope goes to its system owner (or the person's manager when the owner holds it).</p>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Name</span><input autoFocus required minLength={3} maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Q3 production access" /></label>
          <label className="field"><span>Systems</span><select value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value })}><option value="">All systems</option>{resources.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <label className="field"><span>Due</span><input type="date" required value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Start review</button></div>
      </form>
    </div>
  );
}

type ReviewDetail = {
  id: string; name: string; dueAt: string; status: string;
  items: { id: string; resource: string; role: string; user: { id: string; name: string; status: string; lastLoginAt: string | null }; grantedAt: string | null; expiresAt: string | null; grantStatus: string; reviewer: string | null; decision: string | null; note: string | null; decidedAt: string | null; canDecide: boolean }[];
  permissions: { canClose: boolean };
};

export function ReviewPage() {
  const { reviewId } = useParams();
  const key = `/access/reviews/${reviewId}`;
  const review = useQuery<ReviewDetail>(reviewId ? key : null, (s) => api.get(key, s));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (review.loading && !review.data) return <Loading rows={4} />;
  if (review.error && !review.data) return (review.error as { status?: number }).status === 404 ? <Empty title="Review not found" action={<Link className="ghost-button" to="/access/reviews">Reviews</Link>} /> : <ErrorState error={review.error} onRetry={review.reload} />;
  const v = review.data!;
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); } invalidate('/access/'); };
  const open = v.items.filter((i) => !i.decision).length;
  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to="/access/reviews" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Reviews</Link>
      <header className="sd-detail-head">
        <div><p className="cc-eyebrow">Access review · {v.status}</p><h2>{v.name}</h2><div className="rl-head-meta"><span>Due {formatDate(v.dueAt)} · {v.items.length - open}/{v.items.length} decided</span></div></div>
        {v.permissions.canClose ? <div className="cc-header-side">
          <button type="button" className="primary-button" disabled={open > 0} title={open ? 'Every grant needs a decision first' : undefined} onClick={() => void act(() => api.post(`/access/reviews/${v.id}/close`, {}))}>Close review</button>
          {open === v.items.length ? <button type="button" className="ghost-button" onClick={() => { if (window.confirm('Delete this review? Nothing has been decided in it yet.')) void act(async () => { await api.delete(`/access/reviews/${v.id}`); navigate('/access/reviews'); }); }}>Delete</button> : null}
        </div> : null}
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="sd-table-wrap">
        <table className="data-table sd-table">
          <thead><tr><th scope="col">Person</th><th scope="col">Access</th><th scope="col">Granted</th><th scope="col">Decision</th></tr></thead>
          <tbody>{v.items.map((i) => (
            <tr key={i.id}>
              <th scope="row">{i.user.name}<span className="sd-sub">{i.user.status !== 'active' ? i.user.status : i.user.lastLoginAt ? `last active ${relativeTime(i.user.lastLoginAt)}` : 'never signed in'}</span></th>
              <td>{i.resource} · {i.role}<span className="sd-sub">reviewer {i.reviewer ?? '—'}</span></td>
              <td>{i.grantedAt ? formatDate(i.grantedAt) : '—'}{i.expiresAt ? <span className="sd-sub">ends {formatDate(i.expiresAt)}</span> : null}</td>
              <td>
                {i.decision ? <><span className={i.decision === 'revoke' ? 'ac-bad' : 'ac-done'}>{i.decision === 'revoke' ? 'Revoke' : 'Keep'}</span><span className="sd-sub">{i.note ?? ''}{i.decidedAt ? ` · ${relativeTime(i.decidedAt)}` : ''}</span></>
                  : i.canDecide ? (
                    <div className="sd-inline">
                      <input aria-label={`Reason for ${i.user.name}`} placeholder="Reason (needed to revoke)" maxLength={500} value={notes[i.id] ?? ''} onChange={(e) => setNotes({ ...notes, [i.id]: e.target.value })} />
                      <button type="button" className="ghost-button" onClick={() => void act(() => api.post(`/access/review-items/${i.id}`, { decision: 'keep', note: notes[i.id] || null }))}>Keep</button>
                      <button type="button" className="ghost-button" onClick={() => void act(() => api.post(`/access/review-items/${i.id}`, { decision: 'revoke', note: notes[i.id] || null }))}>Revoke</button>
                    </div>
                  ) : <span className="sd-muted">Waiting for {i.reviewer ?? 'reviewer'}</span>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

type Offboarding = { id: string; user: { id: string; name: string }; successor: string | null; performedBy: string | null; reason: string; lastDay: string | null; createdAt: string; tasks: number; done: number };
type OffTask = { id: string; offboardingId: string; kind: string; title: string; leaver: string; assignee: { id: string; name: string | null } | null; doneAt: string | null; doneBy: string | null; canComplete: boolean };

export function OffboardingPage() {
  const { can } = useSession();
  const oversee = can('user.suspend') || can('access.audit');
  const offboardings = useQuery<{ items: Offboarding[] }>(oversee ? '/access/offboardings' : null, (s) => api.get('/access/offboardings', s));
  const [selected, setSelected] = useState<string | null>(null);
  const tasksKey = selected ? `/access/offboarding-tasks?offboardingId=${selected}` : '/access/offboarding-tasks?mine=true';
  const tasks = useQuery<{ items: OffTask[] }>(tasksKey, (s) => api.get(tasksKey, s));
  const people = useQuery<Paged<Person>>(can('user.suspend') ? '/users?limit=100' : null, (s) => api.get('/users?limit=100', s));
  const [task, setTask] = useState({ title: '', assigneeId: '' });
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); } invalidate('/access/'); };
  return (
    <div className="module-page cc-page">
      <header className="cc-header"><div><p className="cc-eyebrow">Access</p><h2>Offboarding</h2></div></header>
      <p className="field-hint">People are offboarded from People. The access they held, the equipment they have and anything else to follow up appears here as tasks.</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="sd-detail-grid">
        <section className="cc-panel" aria-label="Tasks">
          <header><h3>{selected ? `Tasks for ${offboardings.data?.items.find((o) => o.id === selected)?.user.name ?? ''}` : 'My tasks'}</h3>{selected ? <button type="button" className="sd-link-button" onClick={() => setSelected(null)}>Show my tasks</button> : null}</header>
          {!tasks.data ? <Loading rows={3} /> : tasks.data.items.length === 0 ? <p className="cc-empty">{selected ? 'No follow-up tasks.' : 'Nothing assigned to you.'}</p> : (
            <ul className="cc-rows">{tasks.data.items.map((t) => (
              <li key={t.id} className="cc-row">
                <span className="cc-row-main"><strong>{t.title}</strong><span>{t.kind === 'access' ? 'Access' : t.kind === 'asset' ? 'Equipment' : 'Task'} · {t.leaver} · {t.assignee?.name ?? 'unassigned'}{t.doneAt ? ` · done by ${t.doneBy} ${relativeTime(t.doneAt)}` : ''}</span></span>
                {t.kind === 'custom' && !t.doneAt && can('user.suspend') ? <button type="button" className="sd-link-button" onClick={() => void act(() => api.delete(`/access/offboarding-tasks/${t.id}`))}>Remove</button> : null}
                {t.doneAt ? <span className="cc-tag cc-tag-info">Done</span> : t.canComplete ? <button type="button" className="ghost-button" onClick={() => void act(() => api.post(`/access/offboarding-tasks/${t.id}/done`, {}))}>{t.kind === 'access' ? 'Confirm removed' : t.kind === 'asset' ? 'Confirm collected' : 'Mark done'}</button> : <span className="cc-tag">Open</span>}
              </li>
            ))}</ul>
          )}
          {selected && can('user.suspend') ? (
            <form className="sd-panel-pad sd-inline" aria-label="Add a task" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post(`/access/offboardings/${selected}/tasks`, { title: task.title, assigneeId: task.assigneeId || null }); setTask({ title: '', assigneeId: '' }); }); }}>
              <input aria-label="New task" required minLength={3} maxLength={300} placeholder="Add a task, e.g. transfer the domain registrar" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
              <select aria-label="Assign to" value={task.assigneeId} onChange={(e) => setTask({ ...task, assigneeId: e.target.value })}><option value="">Me</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select>
              <button type="submit" className="ghost-button">Add</button>
            </form>
          ) : null}
        </section>
        {oversee ? (
          <section className="cc-panel" aria-label="Offboardings">
            <header><h3>Departures</h3></header>
            {!offboardings.data ? <Loading rows={2} /> : offboardings.data.items.length === 0 ? <p className="cc-empty">Nobody has been offboarded.</p> : (
              <ul className="cc-rows">{offboardings.data.items.map((o) => (
                <li key={o.id}><button type="button" className="cc-row ac-row-button" aria-pressed={selected === o.id} onClick={() => setSelected(o.id)}>
                  <span className="cc-row-main"><strong>{o.user.name}</strong><span>{formatDate(o.createdAt)} · {o.successor ? `work to ${o.successor}` : 'no successor'} · {o.done}/{o.tasks} tasks done</span></span>
                </button></li>
              ))}</ul>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
