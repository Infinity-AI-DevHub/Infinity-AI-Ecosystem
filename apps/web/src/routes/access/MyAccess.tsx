/**
 * My access: what I have, what I have asked for, and asking for more. Anyone can see the
 * catalogue of systems; each request goes through approval.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDate, relativeTime } from '../../lib/format';
import { ErrorState, Loading } from '../../components/States';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/academy.css';

export type Resource = { id: string; name: string; description: string | null; kind: string; roles: string[]; risk: 'low' | 'medium' | 'high'; isActive: boolean; owner: { id: string; name: string | null } | null; service: { id: string; name: string | null } | null; maxDays: number | null; requiredCourse: { id: string; title: string | null } | null; activeGrants?: number; myRoles: string[]; canManage: boolean };
export type Grant = { id: string; resource: { id: string; name: string; risk: string }; role: string; user: { id: string; name: string; status: string }; status: 'pending_grant' | 'active' | 'pending_removal' | 'removed'; source: string; requestRef: string | null; expiresAt: string | null; provisionedAt: string | null; provisionedBy: string | null; removalReason: string | null; removalNote: string | null; removedAt: string | null; createdAt: string; canAct: boolean };
type Request = { id: string; ref: string; resource: { id: string; name: string; risk: string }; role: string; user: { id: string; name: string }; requester: { id: string; name: string }; justification: string; durationDays: number | null; status: string; approval: { id: string; ref: string | null } | null; grantStatus: string | null; createdAt: string; canCancel: boolean };

export const GRANT_LABEL: Record<Grant['status'], string> = { pending_grant: 'Waiting to be set up', active: 'Active', pending_removal: 'Waiting to be removed', removed: 'Removed' };
export const REASON_LABEL: Record<string, string> = { expired: 'temporary access ended', review: 'revoked in review', revoked: 'revoked', offboarding: 'offboarded', superseded: 'replaced', declined: 'declined' };

export function RiskTag({ risk }: { risk: string }) {
  return <span className={`cc-tag ${risk === 'high' ? 'cc-tag-critical' : risk === 'medium' ? '' : 'cc-tag-info'}`}>{risk} risk</span>;
}

export default function MyAccess() {
  const { can } = useSession();
  const grants = useQuery<{ items: Grant[] }>('/access/grants?view=mine', (s) => api.get('/access/grants?view=mine', s));
  const requests = useQuery<{ items: Request[] }>('/access/requests?scope=mine', (s) => api.get('/access/requests?scope=mine', s));
  const resources = useQuery<{ items: Resource[] }>('/access/resources', (s) => api.get('/access/resources', s));
  const [asking, setAsking] = useState<Resource | 'pick' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = grants.data?.items.filter((g) => g.status !== 'removed') ?? [];

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Access</p><h2>My access</h2></div>
        <div className="cc-header-side">{can('access.request') ? <button type="button" className="primary-button" onClick={() => setAsking('pick')}><Plus size={15} aria-hidden="true" /> Request access</button> : null}</div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      <section className="cc-panel" aria-label="Access I have">
        <header><h3>Access I have</h3><span className="cc-meta">{current.length}</span></header>
        {grants.loading && !grants.data ? <Loading rows={2} /> : grants.error && !grants.data ? <ErrorState error={grants.error} onRetry={grants.reload} />
          : current.length === 0 ? <p className="cc-empty">No access recorded for you.</p> : (
            <ul className="cc-rows">{current.map((g) => (
              <li key={g.id} className="cc-row">
                <span className="cc-row-main">
                  <strong>{g.resource.name} · {g.role}</strong>
                  <span>{GRANT_LABEL[g.status]}{g.expiresAt ? ` · ends ${formatDate(g.expiresAt)}` : g.status === 'active' ? ' · no end date' : ''}{g.requestRef ? ` · ${g.requestRef}` : ''}{g.removalReason ? ` · ${REASON_LABEL[g.removalReason]}` : ''}</span>
                </span>
                {g.expiresAt && g.status === 'active' && new Date(g.expiresAt).getTime() - Date.now() < 3 * 86_400_000 ? <span className="cc-tag cc-tag-critical">Ending soon</span> : null}
              </li>
            ))}</ul>
          )}
      </section>

      <section className="cc-panel" aria-label="My requests">
        <header><h3>My requests</h3></header>
        {!requests.data ? <Loading rows={2} /> : requests.data.items.length === 0 ? <p className="cc-empty">You have not asked for access.</p> : (
          <ul className="cc-rows">{requests.data.items.map((r) => (
            <li key={r.id} className="cc-row">
              <span className="cc-row-main">
                <strong>{r.ref} · {r.resource.name} · {r.role}{r.user.id !== r.requester.id ? ` for ${r.user.name}` : ''}</strong>
                <span>{r.durationDays ? `${r.durationDays} days` : 'Permanent'} · asked {relativeTime(r.createdAt)}{r.approval?.ref ? <> · <Link to={`/approvals/${r.approval.id}`}>{r.approval.ref}</Link></> : null}</span>
              </span>
              <span className={`cc-tag ${r.status === 'rejected' ? 'cc-tag-critical' : r.status === 'approved' ? 'cc-tag-info' : ''}`}>{r.status === 'approved' && r.grantStatus ? GRANT_LABEL[r.grantStatus as Grant['status']] : r.status}</span>
              {r.canCancel ? <button type="button" className="sd-link-button" onClick={async () => { setError(null); try { await api.post(`/access/requests/${r.id}/cancel`, {}); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not withdrawn.'); } invalidate('/access/'); }}>Withdraw</button> : null}
            </li>
          ))}</ul>
        )}
      </section>

      <section className="cc-panel" aria-label="Systems">
        <header><h3>Systems you can ask for</h3></header>
        {!resources.data ? <Loading rows={2} /> : resources.data.items.length === 0 ? <p className="cc-empty">No systems are in the catalogue yet.</p> : (
          <ul className="cc-rows">{resources.data.items.map((r) => (
            <li key={r.id} className="cc-row">
              <span className="cc-row-main">
                <strong>{r.name}</strong>
                <span>{r.description ?? r.kind} · owner {r.owner?.name ?? 'administrators'}{r.maxDays ? ` · temporary, up to ${r.maxDays} days` : ''}{r.requiredCourse ? ` · needs "${r.requiredCourse.title}"` : ''}{r.myRoles.length ? ` · you have ${r.myRoles.join(', ')}` : ''}</span>
              </span>
              <RiskTag risk={r.risk} />
              {can('access.request') ? <button type="button" className="sd-link-button" onClick={() => setAsking(r)}>Request</button> : null}
            </li>
          ))}</ul>
        )}
      </section>

      {asking ? <RequestDialog resources={resources.data?.items ?? []} initial={asking === 'pick' ? null : asking} onClose={() => { setAsking(null); invalidate('/access/'); }} /> : null}
    </div>
  );
}

function RequestDialog({ resources, initial, onClose }: { resources: Resource[]; initial: Resource | null; onClose: () => void }) {
  const { session } = useSession();
  const people = useQuery<Paged<{ id: string; displayName: string; managerId?: string | null }>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const [f, setF] = useState({ resourceId: initial?.id ?? resources[0]?.id ?? '', role: initial?.roles[0] ?? resources[0]?.roles[0] ?? '', userId: '', justification: '', durationDays: initial?.maxDays ?? '' as number | '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const r = resources.find((x) => x.id === f.resourceId);
  const reports = people.data?.items.filter((p) => p.managerId === session?.user?.id) ?? [];
  if (done) {
    return (
      <div className="dialog-scrim" role="presentation" onClick={onClose}>
        <div className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="req-done" onClick={(e) => e.stopPropagation()}>
          <h3 id="req-done">Request {done} sent</h3>
          <p>It goes for approval to your manager if you have one{r?.owner ? `, and to ${r.owner.name} as the owner` : ', and to an administrator'}{r?.risk === 'high' ? ', then to an administrator because the risk is high' : ''}. You can follow it under My requests. Access is only counted as given once {r?.owner ? r.owner.name : 'an administrator'} confirms it is set up.</p>
          <div className="dialog-actions"><button type="button" className="primary-button" autoFocus onClick={onClose}>Done</button></div>
        </div>
      </div>
    );
  }
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="req-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try {
            const res = await api.post<{ ref: string }>('/access/requests', { resourceId: f.resourceId, role: f.role, userId: f.userId || null, justification: f.justification, durationDays: f.durationDays === '' ? null : Number(f.durationDays) });
            invalidate('/access/requests');
            setDone(res.ref);
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The request was not sent.'); }
        }}>
        <h3 id="req-title">Request access</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>System</span><select autoFocus value={f.resourceId} onChange={(e) => { const next = resources.find((x) => x.id === e.target.value); setF({ ...f, resourceId: e.target.value, role: next?.roles[0] ?? '', durationDays: next?.maxDays ?? '' }); }}>{resources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          {r?.requiredCourse ? <p className="field-hint sd-span-2">Requires the course <Link to={`/academy/courses/${r.requiredCourse.id}`}>{r.requiredCourse.title}</Link>.</p> : null}
          <label className="field"><span>Role</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{r?.roles.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
          <label className="field"><span>For</span><select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">Me</option>{reports.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field"><span>How long (days)</span><input type="number" min={1} max={r?.maxDays ?? 365} required={Boolean(r?.maxDays)} value={f.durationDays} placeholder={r?.maxDays ? `Up to ${r.maxDays}` : 'Leave empty for permanent'} onChange={(e) => setF({ ...f, durationDays: e.target.value === '' ? '' : Number(e.target.value) })} /></label>
          <span />
          <label className="field sd-span-2"><span>Why it is needed</span><textarea required minLength={10} maxLength={1000} rows={3} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!r}>Send request</button></div>
      </form>
    </div>
  );
}
