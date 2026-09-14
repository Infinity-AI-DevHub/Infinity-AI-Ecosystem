/**
 * Change management: the change calendar and each change record.
 *
 * Approval is not decided here. A submitted change appears in the approvers' ordinary
 * Approvals queue, and this page links to that request and reflects its outcome. What the
 * page does own is the plan, the schedule, and recording how implementation went.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, GitPullRequestArrow, Link2, Plus, X } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { formatDateTime, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Empty, ErrorState, Loading } from '../../components/States';
import type { TicketSummary } from '../../lib/service';
import '../../styles/command.css';
import '../../styles/service.css';

type ChangeStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'scheduled' | 'in_progress' | 'implemented' | 'failed' | 'cancelled' | 'closed';
type Risk = 'low' | 'medium' | 'high';
type ChangeSummary = {
  id: string; ref: string; title: string; changeType: 'standard' | 'normal' | 'emergency'; risk: Risk; status: ChangeStatus;
  plannedStart: string | null; plannedEnd: string | null; requesterName?: string; ownerName?: string | null; version: number; outcome: string | null;
};
type Change = ChangeSummary & {
  description: string; impact: string | null; implementationPlan: string | null; rollbackPlan: string | null; testPlan: string | null;
  outcomeNotes: string | null; ownerId: string | null; implementedAt: string | null;
  approval: { id: string; status: string | null; reference: string | null } | null;
  tickets: { id: string; ref: string; subject: string; status: string; type: string }[];
  events: { id: number; kind: string; detail: string | null; createdAt: string; actorName: string | null }[];
  permissions: { canEdit: boolean; canSubmit: boolean; canSchedule: boolean; canStart: boolean; canComplete: boolean; canClose: boolean; canCancel: boolean; canLink: boolean };
};

export const CHANGE_STATUS: Record<ChangeStatus, string> = {
  draft: 'Draft', pending_approval: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected', scheduled: 'Scheduled',
  in_progress: 'In progress', implemented: 'Implemented', failed: 'Failed', cancelled: 'Cancelled', closed: 'Closed',
};
const STATUS_CLASS: Record<ChangeStatus, string> = {
  draft: 'closed', pending_approval: 'pending', approved: 'open', rejected: 'closed', scheduled: 'open',
  in_progress: 'new', implemented: 'resolved', failed: 'failed', cancelled: 'closed', closed: 'closed',
};
const EVENT_VERB: Record<string, string> = {
  created: 'created the change', edited: 'edited the plan', rescheduled: 'rescheduled it', submitted: 'submitted it for approval',
  approved: 'approved it', rejected: 'rejected it', schedule: 'scheduled it', start: 'started implementation',
  complete: 'recorded the outcome', close: 'closed it', cancel: 'cancelled it', ticket_linked: 'linked ticket', ticket_unlinked: 'unlinked ticket',
};
const RISK_LABEL: Record<Risk, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

export function ChangeBadge({ status }: { status: ChangeStatus }) {
  return <span className={`sd-badge sd-status-${STATUS_CLASS[status]}`}>{CHANGE_STATUS[status]}</span>;
}

/** `2026-09-14T09:30` for a datetime-local input, in local time. */
function toLocalInput(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

export default function ChangeList() {
  const [view, setView] = useState<'upcoming' | 'open' | ''>('upcoming');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const key = `/service/changes?limit=100${view ? `&status=${view}` : ''}`;
  const list = useQuery<{ items: ChangeSummary[] }>(key, (signal) => api.get(key, signal));

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Service</p><h2>Changes</h2></div>
        <div className="cc-header-side"><button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> New change</button></div>
      </header>
      <div className="tab-row" role="tablist" aria-label="Change views">
        {([['upcoming', 'Upcoming'], ['open', 'All open'], ['', 'Everything']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={`tab ${view === id ? 'tab-active' : ''}`} onClick={() => setView(id)}>{label}</button>
        ))}
      </div>
      {list.loading && !list.data ? <Loading label="Loading changes" rows={5} />
        : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? (
          <Empty icon={<GitPullRequestArrow size={22} />} title={view === 'upcoming' ? 'No changes scheduled' : 'No changes'}
            description="Planned work on systems people depend on - upgrades, migrations, configuration changes - is recorded and approved here." />
        ) : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Change</th><th scope="col">Window</th><th scope="col">Risk</th><th scope="col">Status</th><th scope="col">Owner</th></tr></thead>
              <tbody>
                {list.data!.items.map((c) => (
                  <tr key={c.id} className="sd-row" onClick={() => navigate(`/service/changes/${c.id}`)}>
                    <th scope="row">
                      <Link to={`/service/changes/${c.id}`} className="sd-subject" onClick={(e) => e.stopPropagation()}><span className="sd-ref">{c.ref}</span><span>{c.title}</span></Link>
                      <span className="sd-sub">{c.changeType === 'standard' ? 'Standard (pre-approved)' : c.changeType === 'emergency' ? 'Emergency' : 'Normal'}</span>
                    </th>
                    <td>{c.plannedStart ? formatDateTime(c.plannedStart) : <span className="sd-muted">Not scheduled</span>}{c.plannedEnd ? <span className="sd-sub">until {formatDateTime(c.plannedEnd)}</span> : null}</td>
                    <td><span className={`sd-risk sd-risk-${c.risk}`}>{RISK_LABEL[c.risk]}</span></td>
                    <td><ChangeBadge status={c.status} /></td>
                    <td>{c.ownerName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {creating ? <ChangeDialog onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); invalidate('/service/changes'); navigate(`/service/changes/${id}`); }} /> : null}
    </div>
  );
}

function ChangeDialog({ change, onClose, onSaved }: { change?: Change; onClose: () => void; onSaved: (id: string) => void }) {
  const { can } = useSession();
  const people = useQuery<Paged<{ id: string; displayName: string }>>(can('user.read') ? '/users?limit=100' : null, (signal) => api.get('/users?limit=100', signal));
  const [form, setForm] = useState({
    title: change?.title ?? '', description: change?.description ?? '', changeType: change?.changeType ?? 'normal', risk: change?.risk ?? 'medium',
    impact: change?.impact ?? '', implementationPlan: change?.implementationPlan ?? '', rollbackPlan: change?.rollbackPlan ?? '', testPlan: change?.testPlan ?? '',
    ownerId: change?.ownerId ?? '', plannedStart: toLocalInput(change?.plannedStart ?? null), plannedEnd: toLocalInput(change?.plannedEnd ?? null),
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="change-dialog-title" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setPending(true); setError(null);
          const body = {
            title: form.title, description: form.description, changeType: form.changeType, risk: form.risk,
            impact: form.impact || null, implementationPlan: form.implementationPlan || null, rollbackPlan: form.rollbackPlan || null, testPlan: form.testPlan || null,
            ownerId: form.ownerId || null, plannedStart: fromLocalInput(form.plannedStart), plannedEnd: fromLocalInput(form.plannedEnd),
          };
          try {
            const saved = change
              ? await api.patch<Change>(`/service/changes/${change.id}`, body, { ifMatch: change.version })
              : await api.post<Change>('/service/changes', body);
            onSaved(saved.id);
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The change was not saved.'); setPending(false); }
        }}>
        <h3 id="change-dialog-title">{change ? 'Edit change' : 'New change'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Title</span><input autoFocus value={form.title} onChange={set('title')} required minLength={3} maxLength={300} placeholder="Upgrade production database to 8.4" /></label>
          <label className="field sd-span-2"><span>What and why</span><textarea rows={3} value={form.description} onChange={set('description')} required maxLength={20000} /></label>
          <label className="field"><span>Type</span><select value={form.changeType} onChange={set('changeType')}><option value="normal">Normal - needs approval</option><option value="standard">Standard - routine, pre-approved</option><option value="emergency">Emergency - expedited approval</option></select></label>
          <label className="field"><span>Risk</span><select value={form.risk} onChange={set('risk')}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High - also needs an administrator</option></select></label>
          <label className="field"><span>Planned start</span><input type="datetime-local" value={form.plannedStart} onChange={set('plannedStart')} /></label>
          <label className="field"><span>Planned end</span><input type="datetime-local" value={form.plannedEnd} onChange={set('plannedEnd')} /></label>
          <label className="field sd-span-2"><span>Owner</span><select value={form.ownerId} onChange={set('ownerId')}><option value="">Me</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field sd-span-2"><span>Impact</span><textarea rows={2} value={form.impact} onChange={set('impact')} maxLength={20000} placeholder="Who and what is affected, and for how long" /></label>
          <label className="field sd-span-2"><span>Implementation plan</span><textarea rows={3} value={form.implementationPlan} onChange={set('implementationPlan')} maxLength={20000} /></label>
          <label className="field sd-span-2"><span>Rollback plan</span><textarea rows={2} value={form.rollbackPlan} onChange={set('rollbackPlan')} maxLength={20000} /></label>
          <label className="field sd-span-2"><span>Test plan</span><textarea rows={2} value={form.testPlan} onChange={set('testPlan')} maxLength={20000} /></label>
        </div>
        <p className="field-hint">Normal and emergency changes need an implementation plan, a rollback plan and a planned start before they can be submitted.</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={pending}>{pending ? 'Saving…' : change ? 'Save' : 'Create draft'}</button></div>
      </form>
    </div>
  );
}

export function ChangeDetail() {
  const { changeId } = useParams();
  const key = `/service/changes/${changeId}`;
  const change = useQuery<Change>(changeId ? key : null, (signal) => api.get(key, signal));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [completing, setCompleting] = useState(false);
  const [outcome, setOutcome] = useState<'successful' | 'failed' | 'rolled_back'>('successful');
  const [notes, setNotes] = useState('');
  const [linking, setLinking] = useState('');

  const tickets = useQuery<Paged<TicketSummary>>(change.data?.permissions.canLink ? '/service/tickets?limit=100&status=active' : null,
    (signal) => api.get('/service/tickets?limit=100&status=active', signal));

  if (change.loading && !change.data) return <Loading label="Loading change" rows={6} />;
  if (change.error && !change.data) {
    return change.error instanceof ApiError && change.error.status === 404
      ? <Empty title="Change not found" action={<Link className="ghost-button" to="/service/changes">All changes</Link>} />
      : <ErrorState error={change.error} onRetry={change.reload} />;
  }
  const c = change.data!;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not go through.'); }
    invalidate(key); invalidate('/service/changes?');
  };
  const transition = (action: string, extra: Record<string, unknown> = {}) => act(() => api.post(`/service/changes/${c.id}/transition`, { action, ...extra }));

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to="/service/changes" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Changes</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">{c.ref} · {c.changeType === 'standard' ? 'Standard change' : c.changeType === 'emergency' ? 'Emergency change' : 'Normal change'}</p>
          <h2>{c.title}</h2>
          <div className="sd-head-badges"><ChangeBadge status={c.status} /><span className={`sd-risk sd-risk-${c.risk}`}>{RISK_LABEL[c.risk]}</span></div>
        </div>
        <div className="cc-header-side">
          {c.permissions.canEdit ? <button type="button" className="ghost-button" onClick={() => setEditing(true)}>Edit</button> : null}
          {c.permissions.canSubmit ? <button type="button" className="primary-button" onClick={() => void act(() => api.post(`/service/changes/${c.id}/submit`, {}))}>{c.changeType === 'standard' ? 'Mark approved' : 'Submit for approval'}</button> : null}
          {c.permissions.canStart ? <button type="button" className="primary-button" onClick={() => void transition('start')}>Start implementation</button> : null}
          {c.permissions.canComplete ? <button type="button" className="primary-button" onClick={() => setCompleting(true)}>Record outcome</button> : null}
          {c.permissions.canClose ? <button type="button" className="ghost-button" onClick={() => void transition('close')}>Close</button> : null}
          {c.permissions.canCancel ? <button type="button" className="ghost-button" onClick={() => void transition('cancel')}>Cancel change</button> : null}
          {c.permissions.canEdit && (c.status === 'draft' || c.status === 'cancelled') ? <button type="button" className="ghost-button" onClick={() => { if (window.confirm(`Delete ${c.ref}? This cannot be undone.`)) void act(async () => { await api.delete(`/service/changes/${c.id}`); navigate('/service/changes'); }); }}>Delete</button> : null}
        </div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      {completing ? (
        <section className="cc-panel sd-panel-pad sd-editor" aria-label="Record outcome">
          <h3 className="sd-subhead">How did it go?</h3>
          <div className="sd-form-grid">
            <label className="field"><span>Outcome</span><select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}><option value="successful">Successful</option><option value="rolled_back">Rolled back</option><option value="failed">Failed</option></select></label>
            <label className="field sd-span-2"><span>Notes</span><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} /></label>
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={() => setCompleting(false)}>Cancel</button>
            <button type="button" className="primary-button" onClick={async () => { await transition('complete', { outcome, notes: notes || null }); setCompleting(false); }}>Save outcome</button>
          </div>
        </section>
      ) : null}

      <div className="sd-detail-grid">
        <div className="sd-main">
          <section className="cc-panel" aria-label="Plan">
            <header><h3>Plan</h3></header>
            <dl className="sd-plan">
              <dt>What and why</dt><dd className="sd-body">{c.description}</dd>
              <dt>Impact</dt><dd className="sd-body">{c.impact || <span className="sd-muted">Not described</span>}</dd>
              <dt>Implementation</dt><dd className="sd-body">{c.implementationPlan || <span className="sd-muted">Not written yet</span>}</dd>
              <dt>Rollback</dt><dd className="sd-body">{c.rollbackPlan || <span className="sd-muted">Not written yet</span>}</dd>
              <dt>Testing</dt><dd className="sd-body">{c.testPlan || <span className="sd-muted">Not described</span>}</dd>
              {c.outcome ? <><dt>Outcome</dt><dd className="sd-body"><strong>{c.outcome === 'successful' ? 'Successful' : c.outcome === 'rolled_back' ? 'Rolled back' : 'Failed'}</strong>{c.outcomeNotes ? ` - ${c.outcomeNotes}` : ''}</dd></> : null}
            </dl>
          </section>
          <section className="cc-panel" aria-label="Related tickets">
            <header><h3>Related tickets</h3></header>
            {c.tickets.length === 0 ? <p className="cc-empty">No tickets linked. Link the incidents or requests this change resolves.</p> : (
              <ul className="cc-rows">{c.tickets.map((t) => (
                <li key={t.id} className="sd-link-row">
                  <Link to={`/service/tickets/${t.id}`} className="cc-row"><span className="sd-ref">{t.ref}</span><span className="cc-row-main"><strong>{t.subject}</strong><span>{t.type} · {t.status}</span></span></Link>
                  {c.permissions.canLink ? <button type="button" className="icon-button" aria-label={`Unlink ${t.ref}`} onClick={() => void act(() => api.delete(`/service/changes/${c.id}/tickets/${t.id}`))}><X size={14} /></button> : null}
                </li>
              ))}</ul>
            )}
            {c.permissions.canLink ? (
              <div className="sd-panel-pad sd-inline">
                <select aria-label="Ticket to link" value={linking} onChange={(e) => setLinking(e.target.value)}>
                  <option value="">{tickets.data ? 'Link an open ticket…' : 'Loading tickets…'}</option>
                  {tickets.data?.items.filter((t) => !c.tickets.some((l) => l.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.ref} · {t.subject}</option>)}
                </select>
                <button type="button" className="ghost-button" disabled={!linking} onClick={() => void act(async () => { await api.post(`/service/changes/${c.id}/tickets`, { ticketId: linking }); setLinking(''); })}><Link2 size={14} aria-hidden="true" /> Link</button>
              </div>
            ) : null}
          </section>
        </div>
        <aside className="sd-side">
          <section className="cc-panel" aria-label="Schedule">
            <header><h3>Schedule</h3></header>
            <dl className="sd-props">
              <dt>Start</dt><dd>{c.plannedStart ? formatDateTime(c.plannedStart) : 'Not scheduled'}</dd>
              <dt>End</dt><dd>{c.plannedEnd ? formatDateTime(c.plannedEnd) : '—'}</dd>
              {c.implementedAt ? <><dt>Implemented</dt><dd>{formatDateTime(c.implementedAt)}</dd></> : null}
              <dt>Owner</dt><dd>{c.ownerName ?? '—'}</dd>
              <dt>Requested by</dt><dd>{c.requesterName}</dd>
            </dl>
            {c.permissions.canSchedule ? <Reschedule change={c} onSave={(start, end) => transition('schedule', { plannedStart: start, plannedEnd: end ?? undefined })} /> : null}
          </section>
          <section className="cc-panel" aria-label="Approval">
            <header><h3>Approval</h3></header>
            <div className="sd-panel-pad">
              {c.approval ? (
                <p className="sd-body">
                  <Link to={`/approvals/${c.approval.id}`}>{c.approval.reference}</Link> - {c.approval.status === 'pending' ? 'waiting for approvers' : c.approval.status}
                </p>
              ) : c.changeType === 'standard' && !['draft'].includes(c.status) ? (
                <p className="sd-body">Standard change - pre-approved.</p>
              ) : (
                <p className="field-hint">Submitted changes go to the requester's manager; high-risk changes also to an administrator. Decisions are made in Approvals.</p>
              )}
            </div>
          </section>
          <section className="cc-panel" aria-label="History">
            <header><h3>History</h3></header>
            <ol className="sd-timeline">
              {c.events.map((e) => (
                <li key={e.id}><span className={`sd-tl-dot sd-tl-${e.kind}`} aria-hidden="true" />
                  <div><span><strong>{e.actorName ?? 'Approvals'}</strong> {EVENT_VERB[e.kind] ?? e.kind.replace('_', ' ')}{e.detail ? ` - ${e.kind === 'schedule' ? formatDateTime(e.detail) : e.kind === 'complete' ? e.detail.replace('_', ' ') : e.detail}` : ''}</span><time dateTime={e.createdAt}>{relativeTime(e.createdAt)}</time></div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
      {editing ? <ChangeDialog change={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); invalidate(key); invalidate('/service/changes?'); }} /> : null}
    </div>
  );
}

function Reschedule({ change, onSave }: { change: Change; onSave: (start: string, end: string | null) => Promise<void> }) {
  const [start, setStart] = useState(toLocalInput(change.plannedStart));
  const [end, setEnd] = useState(toLocalInput(change.plannedEnd));
  return (
    <div className="sd-panel-pad sd-fields">
      <label className="field"><span>Start</span><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
      <label className="field"><span>End</span><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      <button type="button" className="ghost-button" disabled={!start} onClick={() => void onSave(fromLocalInput(start)!, fromLocalInput(end))}>
        {change.status === 'scheduled' ? 'Reschedule' : 'Schedule'}
      </button>
    </div>
  );
}
