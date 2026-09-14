/**
 * Policies: read and acknowledge the current version; policy managers draft, publish new
 * versions, retire them and see who has acknowledged.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDate, formatDateTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/academy.css';

type PolicyItem = { id: string; title: string; category: string | null; status: string; version: number | null; publishedAt: string | null; audience: string; appliesToMe: boolean; acknowledgedAt: string | null; dueAt: string | null; overdue: boolean };
type PolicyDetail = {
  id: string; title: string; category: string | null; status: string; audienceGroupId: string | null; ackDueDays: number; ownerId: string | null;
  current: { version: number; body: string; changeNote: string | null; publishedAt: string; publishedBy: string | null } | null;
  acknowledgedAt: string | null; draftBody?: string | null;
  history?: { version: number; changeNote: string | null; publishedAt: string; publishedBy: string | null }[];
  permissions: { canManage: boolean; mustAcknowledge: boolean };
};

export default function Policies() {
  const { can } = useSession();
  const navigate = useNavigate();
  const list = useQuery<{ items: PolicyItem[] }>('/academy/policies', (s) => api.get('/academy/policies', s));
  const [creating, setCreating] = useState(false);
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Academy</p><h2>Policies</h2></div>
        <div className="cc-header-side">{can('policy.manage') ? <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> New policy</button> : null}</div>
      </header>
      {list.loading && !list.data ? <Loading rows={4} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No policies" description={can('policy.manage') ? 'Write a policy and publish it for people to acknowledge.' : 'Policies you need to read appear here.'} />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Policy</th><th scope="col">Applies to</th><th scope="col">Version</th><th scope="col">Your acknowledgement</th></tr></thead>
              <tbody>{list.data!.items.map((p) => (
                <tr key={p.id} className="sd-row" onClick={() => navigate(`/academy/policies/${p.id}`)}>
                  <th scope="row"><Link to={`/academy/policies/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.title}</Link><span className="sd-sub">{p.category ?? 'General'}{p.status !== 'published' ? ` · ${p.status}` : ''}</span></th>
                  <td>{p.audience}</td>
                  <td>{p.version ? `v${p.version} · ${formatDate(p.publishedAt!)}` : 'Not published'}</td>
                  <td>{!p.appliesToMe ? <span className="sd-muted">Not required</span> : p.acknowledgedAt ? <span className="ac-done"><CheckCircle2 size={14} aria-hidden="true" /> {formatDate(p.acknowledgedAt)}</span> : <span className={p.overdue ? 'ac-bad' : 'ac-warn'}>{p.overdue ? 'Overdue' : `Due ${p.dueAt ? formatDate(p.dueAt) : ''}`}</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      {creating ? <PolicyDialog onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); invalidate('/academy/'); navigate(`/academy/policies/${id}`); }} /> : null}
    </div>
  );
}

export function PolicyPage() {
  const { policyId } = useParams();
  const key = `/academy/policies/${policyId}`;
  const policy = useQuery<PolicyDetail>(policyId ? key : null, (s) => api.get(key, s));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const navigate = useNavigate();
  if (policy.loading && !policy.data) return <Loading rows={5} />;
  if (policy.error && !policy.data) {
    return (policy.error as { status?: number }).status === 404 ? <Empty title="Policy not found" action={<Link className="ghost-button" to="/academy/policies">Policies</Link>} /> : <ErrorState error={policy.error} onRetry={policy.reload} />;
  }
  const p = policy.data!;
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); } invalidate('/academy/'); };
  const draftChanged = p.permissions.canManage && p.draftBody !== undefined && p.draftBody !== (p.current?.body ?? null);

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to="/academy/policies" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Policies</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">{p.category ?? 'Policy'} · {p.status}</p>
          <h2>{p.title}</h2>
          {p.current ? <div className="rl-head-meta"><span>Version {p.current.version} · published {formatDate(p.current.publishedAt)}{p.current.publishedBy ? ` by ${p.current.publishedBy}` : ''}</span>{p.current.changeNote ? <span>What changed: {p.current.changeNote}</span> : null}</div> : null}
        </div>
        {p.permissions.canManage ? (
          <div className="cc-header-side">
            <button type="button" className="ghost-button" onClick={() => setEditing(true)}>Edit draft</button>
            {p.status === 'published' ? <button type="button" className="ghost-button" onClick={() => { if (window.confirm('Retire this policy? Nobody will be asked to acknowledge it.')) void act(() => api.post(`/academy/policies/${p.id}/retire`, {})); }}>Retire</button> : null}
            {!p.current ? <button type="button" className="ghost-button" onClick={() => { if (window.confirm('Delete this draft policy?')) void act(async () => { await api.delete(`/academy/policies/${p.id}`); navigate('/academy/policies'); }); }}>Delete</button> : null}
          </div>
        ) : null}
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      <div className="sd-detail-grid">
        <div className="sd-main">
          <section className="cc-panel ac-policy" aria-label="Policy text">
            {p.current ? <div className="ac-policy-text">{p.current.body}</div> : <p className="cc-empty">Not published yet.</p>}
            {p.current ? (
              <div className="ac-ack">
                {p.acknowledgedAt ? <span className="ac-done"><CheckCircle2 size={15} aria-hidden="true" /> You acknowledged version {p.current.version} on {formatDateTime(p.acknowledgedAt)}</span>
                  : p.permissions.mustAcknowledge ? <><span>I have read and understood this policy.</span><button type="button" className="primary-button" onClick={() => void act(() => api.post(`/academy/policies/${p.id}/acknowledge`, {}))}>Acknowledge</button></>
                  : <span className="field-hint">You are not in this policy's audience.</span>}
              </div>
            ) : null}
          </section>
        </div>
        {p.permissions.canManage ? (
          <aside className="sd-side">
            <section className="cc-panel" aria-label="Publish">
              <header><h3>Draft</h3><span className="cc-meta">{draftChanged ? 'Unpublished changes' : 'Matches the published version'}</span></header>
              {draftChanged ? (
                <form className="sd-panel-pad sd-editor" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post(`/academy/policies/${p.id}/publish`, { changeNote: changeNote || null }); setChangeNote(''); }); }}>
                  {p.current ? <label className="field"><span>What changed</span><input maxLength={500} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} /></label> : null}
                  <button type="submit" className="primary-button">Publish version {(p.current?.version ?? 0) + 1}</button>
                  <p className="field-hint">Everyone in the audience is asked to acknowledge it{p.current ? ' again' : ''}.</p>
                </form>
              ) : null}
            </section>
            <Coverage policyId={p.id} />
            {p.history?.length ? (
              <section className="cc-panel" aria-label="Versions">
                <header><h3>Versions</h3></header>
                <ul className="cc-rows">{p.history.map((v) => <li key={v.version} className="cc-row"><span className="cc-row-main"><strong>v{v.version}</strong><span>{formatDate(v.publishedAt)}{v.publishedBy ? ` · ${v.publishedBy}` : ''}{v.changeNote ? ` · ${v.changeNote}` : ''}</span></span></li>)}</ul>
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>
      {editing ? <PolicyDialog policy={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); invalidate('/academy/'); }} /> : null}
    </div>
  );
}

function Coverage({ policyId }: { policyId: string }) {
  const key = `/academy/policies/${policyId}/coverage`;
  const cov = useQuery<{ version: number | null; dueAt: string | null; total: number; acknowledged: number; overdue: boolean; items: { userId: string; name: string; acknowledgedAt: string | null }[] }>(key, (s) => api.get(key, s));
  if (!cov.data) return null;
  const missing = cov.data.items.filter((i) => !i.acknowledgedAt);
  return (
    <section className="cc-panel" aria-label="Acknowledgements">
      <header><h3>Acknowledgements</h3><span className="cc-meta">{cov.data.acknowledged}/{cov.data.total}</span></header>
      {cov.data.version === null ? <p className="cc-empty">Publish to start collecting acknowledgements.</p> : (
        <>
          <div className="sd-panel-pad"><div className="ac-progress" aria-hidden="true"><span style={{ width: `${cov.data.total ? (cov.data.acknowledged / cov.data.total) * 100 : 0}%` }} /></div>
            <p className="field-hint">{cov.data.dueAt ? `${cov.data.overdue ? 'Was due' : 'Due'} ${formatDate(cov.data.dueAt)}` : ''}</p></div>
          {missing.length ? <ul className="cc-rows">{missing.slice(0, 20).map((m) => <li key={m.userId} className="cc-row"><span className="cc-row-main"><strong>{m.name}</strong><span>Not yet</span></span></li>)}</ul> : <p className="cc-empty">Everyone has acknowledged.</p>}
        </>
      )}
    </section>
  );
}

function PolicyDialog({ policy, onClose, onSaved }: { policy?: PolicyDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const groups = useQuery<{ items: { id: string; name: string }[] }>('/engineering/teams', (s) => api.get('/engineering/teams', s));
  const [f, setF] = useState({ title: policy?.title ?? '', category: policy?.category ?? '', audienceGroupId: policy?.audienceGroupId ?? '', ackDueDays: policy?.ackDueDays ?? 14, draftBody: policy?.draftBody ?? '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog ac-editor" role="dialog" aria-modal="true" aria-labelledby="policy-dialog-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { title: f.title, category: f.category || null, audienceGroupId: f.audienceGroupId || null, ackDueDays: f.ackDueDays, draftBody: f.draftBody };
          try {
            if (policy) { await api.put(`/academy/policies/${policy.id}`, body); onSaved(policy.id); }
            else { const res = await api.post<{ id: string }>('/academy/policies', body); onSaved(res.id); }
          } catch (err) { setError(err instanceof ApiError ? err.message : 'Not saved.'); }
        }}>
        <h3 id="policy-dialog-title">{policy ? 'Edit draft' : 'New policy'}</h3>
        <p className="field-hint">Saving keeps a draft. People see it only when you publish.</p>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Title</span><input autoFocus required minLength={3} maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field"><span>Category</span><input maxLength={60} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Security" /></label>
          <label className="field"><span>Acknowledge within (days)</span><input type="number" min={1} max={365} value={f.ackDueDays} onChange={(e) => setF({ ...f, ackDueDays: Number(e.target.value) })} /></label>
          <label className="field sd-span-2"><span>Applies to</span><select value={f.audienceGroupId} onChange={(e) => setF({ ...f, audienceGroupId: e.target.value })}><option value="">Every employee</option>{groups.data?.items.map((g) => <option key={g.id} value={g.id}>Members of {g.name}</option>)}</select></label>
          <label className="field sd-span-2"><span>Policy text</span><textarea value={f.draftBody} onChange={(e) => setF({ ...f, draftBody: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save draft</button></div>
      </form>
    </div>
  );
}
