/**
 * One ticket: conversation on the left, the working fields on the right.
 *
 * What is editable comes from the server's `permissions` block rather than from role
 * guesses here, so a requester, a queue member and an auditor each get the right page
 * from the same component. Every change is sent with the version the page was showing;
 * if somebody else changed the ticket first the server refuses and the page reloads it.
 */
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, CheckCircle2, Link2, Lock, Paperclip, RotateCcw, Send, Star, X, XCircle,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatBytes, formatDate, formatDateTime, relativeTime } from '../../lib/format';
import { openExternal } from '../../lib/desktop';
import { uploadWorkspaceFile } from '../../lib/uploads';
import { Empty, ErrorState, Loading } from '../../components/States';
import {
  dueIn, PRIORITY_LABEL, PriorityBadge, SlaBadge, StatusBadge, STATUS_LABEL, TYPE_LABEL,
  type Queue, type TicketDetail as Ticket, type TicketPriority, type TicketStatus, type TicketType,
} from '../../lib/service';
import '../../styles/command.css';
import '../../styles/service.css';

const EVENT_TEXT: Record<string, (e: Ticket['events'][number]) => string> = {
  created: (e) => `raised the ticket${e.to === 'portal' ? ' from the client portal' : ''}`,
  status: (e) => `changed status from ${STATUS_LABEL[e.from as TicketStatus] ?? e.from} to ${STATUS_LABEL[e.to as TicketStatus] ?? e.to}`,
  priority: (e) => `changed priority from ${PRIORITY_LABEL[e.from as TicketPriority] ?? e.from} to ${PRIORITY_LABEL[e.to as TicketPriority] ?? e.to}`,
  type: (e) => `changed type to ${TYPE_LABEL[e.to as TicketType] ?? e.to}`,
  assignee: (e) => (e.to ? `assigned it to ${e.to}` : 'unassigned it'),
  queue: (e) => `moved it to ${e.to ?? 'another queue'}`,
  category: (e) => (e.to ? `set the category to ${e.to}` : 'cleared the category'),
  client: (e) => (e.to ? `linked it to ${e.to}` : 'removed the client'),
  subject: () => 'edited the subject',
  reply: () => 'replied',
  note: () => 'added an internal note',
  attachment: (e) => `attached ${e.to}`,
  task: (e) => `created the task “${e.to ?? 'task'}”`,
  feedback: (e) => `rated the support ${e.to}/5`,
  sla_breach: (e) => (e.to === 'first_response' ? 'missed the first-response target' : 'missed the resolution target'),
  article: (e) => `linked the article “${e.to}”`,
  problem: (e) => (e.to ? `linked it to problem ${e.to}` : 'removed the problem link'),
  incident: (e) => `linked incident ${e.to}`,
  root_cause: () => 'recorded the root cause',
  workaround: () => 'recorded a workaround',
  asset: (e) => `linked device ${e.to}`,
  asset_removed: (e) => `removed device ${e.to}`,
};

export default function TicketDetail({ apiBase = '/service' }: { apiBase?: '/service' | '/portal' }) {
  const { ticketId } = useParams();
  const key = `${apiBase}/tickets/${ticketId}`;
  const ticket = useQuery<Ticket>(ticketId ? key : null, (signal) => api.get(key, signal));
  const [actionError, setActionError] = useState<string | null>(null);
  const portal = apiBase === '/portal';
  const navigate = useNavigate();
  const { can } = useSession();

  if (ticket.loading && !ticket.data) return <Loading label="Loading ticket" rows={6} />;
  if (ticket.error && !ticket.data) {
    return ticket.error instanceof ApiError && ticket.error.status === 404
      ? <Empty title="Ticket not found" description="It may have been raised in another workspace, or you do not have access to it."
          action={<Link className="ghost-button" to={portal ? '/portal/tickets' : '/service'}>Back to tickets</Link>} />
      : <ErrorState error={ticket.error} onRetry={ticket.reload} />;
  }
  const t = ticket.data!;

  const refresh = () => { invalidate(key); invalidate(`${apiBase}/tickets?`); };
  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'That did not go through. Try again.');
    }
    refresh();
  };
  const setStatus = (status: TicketStatus) => run(() => portal
    ? api.post(`/portal/tickets/${t.id}/status`, { status })
    : api.patch(`/service/tickets/${t.id}`, { status }, { ifMatch: t.version }));

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to={portal ? '/portal/tickets' : '/service'} className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> {portal ? 'Support requests' : 'Service desk'}</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">{t.ref} · {TYPE_LABEL[t.type]}{t.clientName && !portal ? ` · ${t.clientName}` : ''}</p>
          <h2>{t.subject}</h2>
          <div className="sd-head-badges">
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            {!portal ? <SlaBadge ticket={t} /> : null}
          </div>
        </div>
        <div className="cc-header-side">
          {t.permissions.canWork && t.status !== 'resolved' && t.status !== 'closed' ? (
            <button type="button" className="primary-button" onClick={() => void setStatus('resolved')}>
              <CheckCircle2 size={15} aria-hidden="true" /> Resolve
            </button>
          ) : null}
          {t.permissions.canReopen ? (
            <button type="button" className="ghost-button" onClick={() => void setStatus('open')}>
              <RotateCcw size={15} aria-hidden="true" /> Reopen
            </button>
          ) : null}
          {t.permissions.canClose ? (
            <button type="button" className="ghost-button" onClick={() => void setStatus('closed')}>
              <XCircle size={15} aria-hidden="true" /> Close
            </button>
          ) : null}
          {!portal && can('service.manage') ? (
            <button type="button" className="ghost-button" onClick={() => {
              if (!window.confirm(`Delete ${t.ref} permanently? Use this for spam or duplicates; real requests should be closed instead.`)) return;
              void run(async () => { await api.delete(`/service/tickets/${t.id}`); navigate('/service'); });
            }}>Delete</button>
          ) : null}
        </div>
      </header>
      {actionError ? <p className="field-error" role="alert">{actionError}</p> : null}

      <div className="sd-detail-grid">
        <div className="sd-main">
          {t.form.length > 0 ? (
            <section className="cc-panel" aria-label="Request details">
              <header><h3>Request details</h3></header>
              <dl className="sd-props">
                {t.form.map((f) => (
                  <FormAnswer key={f.key} label={f.label} value={f.type === 'checkbox' ? (f.value ? 'Yes' : 'No') : String(f.value)} />
                ))}
              </dl>
            </section>
          ) : null}

          {t.type === 'problem' && !portal ? <ProblemRecord ticket={t} onDone={refresh} onError={setActionError} /> : null}

          <section className="cc-panel sd-conversation" aria-label="Conversation">
            <article className="sd-message sd-message-requester">
              <header><strong>{t.requesterName}</strong><time dateTime={t.createdAt}>{formatDateTime(t.createdAt)}</time></header>
              <p className="sd-body">{t.description}</p>
            </article>
            {t.comments.map((c) => (
              <article key={c.id} className={`sd-message ${c.visibility === 'internal' ? 'sd-message-internal' : c.fromRequesterSide ? 'sd-message-requester' : 'sd-message-agent'}`}>
                <header>
                  <strong>{c.authorName}</strong>
                  {c.visibility === 'internal' ? <span className="sd-internal-tag"><Lock size={11} aria-hidden="true" /> Internal note</span> : null}
                  <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time>
                </header>
                <p className="sd-body">{c.body}</p>
              </article>
            ))}
            {t.permissions.canReply && !(t.status === 'closed' && !t.permissions.canWork) ? (
              <Composer ticket={t} apiBase={apiBase} onDone={refresh} />
            ) : t.status === 'closed' ? (
              <p className="cc-empty">This ticket is closed. Reopen it to continue the conversation.</p>
            ) : null}
          </section>

          {t.permissions.canRate ? <Feedback ticket={t} apiBase={apiBase} onDone={refresh} /> : null}
          {t.feedback ? (
            <section className="cc-panel" aria-label="Satisfaction">
              <header><h3>Requester satisfaction</h3></header>
              <div className="sd-panel-pad">
                <Stars value={t.feedback.rating} />
                {t.feedback.comment ? <p className="sd-body">{t.feedback.comment}</p> : null}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="sd-side">
          {t.permissions.canWork ? <WorkPanel ticket={t} onError={setActionError} onDone={refresh} /> : (
            <section className="cc-panel" aria-label="Details">
              <header><h3>Details</h3></header>
              <dl className="sd-props">
                {!portal ? <><dt>Queue</dt><dd>{t.queueName}</dd></> : null}
                <dt>Assigned to</dt><dd>{t.assigneeName ?? 'Not yet assigned'}</dd>
                {t.categoryName ? <><dt>Category</dt><dd>{t.categoryName}</dd></> : null}
                <dt>Raised</dt><dd>{formatDateTime(t.createdAt)}</dd>
                {t.resolvedAt ? <><dt>Resolved</dt><dd>{formatDateTime(t.resolvedAt)}</dd></> : null}
              </dl>
            </section>
          )}

          {!portal ? (
            <section className="cc-panel" aria-label="Service levels">
              <header><h3>Service levels</h3></header>
              <dl className="sd-props">
                {t.sla.pausedSince ? <><dt>Clock</dt><dd className="sd-target sd-target-paused">Paused while waiting on the requester</dd></> : null}
                <dt>First response</dt>
                <dd className={`sd-target sd-target-${t.sla.firstResponse}`}>
                  {t.firstRespondedAt ? `Responded ${relativeTime(t.firstRespondedAt)}` : `Due ${dueIn(t.sla.firstResponseDueAt)}`}
                </dd>
                <dt>Resolution</dt>
                <dd className={`sd-target sd-target-${t.sla.resolution}`}>
                  {t.resolvedAt ? `Resolved ${relativeTime(t.resolvedAt)}` : `Due ${dueIn(t.sla.resolutionDueAt)}`}
                </dd>
              </dl>
            </section>
          ) : null}

          <Attachments ticket={t} apiBase={apiBase} onDone={refresh} onError={setActionError} />

          {t.articles.length > 0 || t.permissions.canWork ? (
            <ArticlesPanel ticket={t} portal={portal} onDone={refresh} onError={setActionError} />
          ) : null}

          {!portal && t.type !== 'problem' && (t.problem || t.permissions.canWork) ? (
            <ProblemLink ticket={t} onDone={refresh} onError={setActionError} />
          ) : null}

          {!portal && (t.assets.length > 0 || t.permissions.canWork) ? (
            <AssetsPanel ticket={t} onDone={refresh} onError={setActionError} />
          ) : null}

          {!portal && t.changes.length > 0 ? (
            <section className="cc-panel" aria-label="Changes">
              <header><h3>Changes</h3></header>
              <ul className="cc-rows">
                {t.changes.map((c) => (
                  <li key={c.id}><Link to={`/service/changes/${c.id}`} className="cc-row"><span className="sd-ref">{c.ref}</span><span className="cc-row-main"><strong>{c.title}</strong><span>{c.status.replace('_', ' ')}</span></span></Link></li>
                ))}
              </ul>
            </section>
          ) : null}

          {!portal ? (
            <section className="cc-panel" aria-label="Related records">
              <header><h3>Related</h3></header>
              <dl className="sd-props">
                <dt>Requester</dt>
                <dd>{t.requesterName}{t.requesterEmail ? <span className="sd-sub">{t.requesterEmail}</span> : null}</dd>
                {t.clientOrgId ? <><dt>Client</dt><dd><Link to={`/clients/${t.clientOrgId}`}>{t.clientName}</Link></dd></> : null}
                <dt>Task</dt>
                <dd>{t.task ? <Link to={`/tasks/${t.task.id}`}>{t.task.ref} {t.task.title}</Link> : t.permissions.canWork ? <LinkTask ticket={t} onDone={refresh} onError={setActionError} /> : 'None'}</dd>
              </dl>
            </section>
          ) : null}

          <section className="cc-panel" aria-label="Timeline">
            <header><h3>Timeline</h3></header>
            <ol className="sd-timeline">
              {t.events.map((e) => (
                <li key={e.id}>
                  <span className={`sd-tl-dot sd-tl-${e.kind}`} aria-hidden="true" />
                  <div>
                    <span><strong>{e.actorName ?? 'System'}</strong> {(EVENT_TEXT[e.kind] ?? (() => e.kind))(e)}</span>
                    <time dateTime={e.createdAt}>{relativeTime(e.createdAt)}</time>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Composer({ ticket, apiBase, onDone }: { ticket: Ticket; apiBase: string; onDone: () => void }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canNote = ticket.permissions.canWork;

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setPending(true); setError(null);
    try {
      // Spelled out per surface so each endpoint is visibly called from the interface.
      if (apiBase === '/portal') await api.post(`/portal/tickets/${ticket.id}/comments`, { body });
      else await api.post(`/service/tickets/${ticket.id}/comments`, { body, visibility: internal ? 'internal' : 'public' });
      setBody('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your reply was not sent. Try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className={`sd-composer ${internal ? 'is-internal' : ''}`} onSubmit={send}>
      {canNote ? (
        <div className="tab-row" role="tablist" aria-label="Reply type">
          <button type="button" role="tab" aria-selected={!internal} className={`tab ${!internal ? 'tab-active' : ''}`} onClick={() => setInternal(false)}>Reply to requester</button>
          <button type="button" role="tab" aria-selected={internal} className={`tab ${internal ? 'tab-active' : ''}`} onClick={() => setInternal(true)}><Lock size={12} aria-hidden="true" /> Internal note</button>
        </div>
      ) : null}
      <label className="visually-hidden" htmlFor="sd-reply">{internal ? 'Internal note' : 'Reply'}</label>
      <textarea id="sd-reply" rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000}
        placeholder={internal ? 'Visible only to people working this ticket' : canNote ? 'The requester will see this reply' : 'Add a reply'}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(e); }} />
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="sd-composer-actions">
        <span className="field-hint">{internal ? 'Not visible to the requester.' : ''} ⌘/Ctrl + Enter to send</span>
        <button type="submit" className="primary-button" disabled={pending || !body.trim()}>
          <Send size={14} aria-hidden="true" /> {pending ? 'Sending…' : internal ? 'Add note' : 'Send reply'}
        </button>
      </div>
    </form>
  );
}

function WorkPanel({ ticket, onError, onDone }: { ticket: Ticket; onError: (m: string | null) => void; onDone: () => void }) {
  const queues = useQuery<{ items: Queue[] }>('/service/queues', (signal) => api.get('/service/queues', signal));
  const assigneesKey = `/service/queues/${ticket.queueId}/assignees`;
  const assignees = useQuery<{ items: { id: string; display_name: string; is_member: number }[] }>(assigneesKey, (signal) => api.get(assigneesKey, signal));
  const { session } = useSession();
  const [saving, setSaving] = useState(false);
  const queue = queues.data?.items.find((q) => q.id === ticket.queueId);

  const patch = async (input: Record<string, unknown>) => {
    setSaving(true); onError(null);
    try {
      await api.patch(`/service/tickets/${ticket.id}`, input, { ifMatch: ticket.version });
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'That change was not saved.');
    } finally {
      setSaving(false);
      onDone();
    }
  };
  const me = session?.user?.id;

  return (
    <section className="cc-panel" aria-label="Ticket fields" aria-busy={saving}>
      <header><h3>Work this ticket</h3></header>
      <div className="sd-fields">
        <label className="field">
          <span>Status</span>
          <select value={ticket.status} disabled={saving} onChange={(e) => void patch({ status: e.target.value })}>
            {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Assignee</span>
          <div className="sd-inline">
            <select value={ticket.assigneeId ?? ''} disabled={saving || !assignees.data} onChange={(e) => void patch({ assigneeId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {assignees.data?.items.map((p) => <option key={p.id} value={p.id}>{p.display_name}{p.is_member ? '' : ' (all queues)'}</option>)}
            </select>
            {me && ticket.assigneeId !== me && assignees.data?.items.some((p) => p.id === me) ? (
              <button type="button" className="ghost-button" disabled={saving} onClick={() => void patch({ assigneeId: me })}>Take it</button>
            ) : null}
          </div>
        </label>
        <label className="field">
          <span>Priority</span>
          <select value={ticket.priority} disabled={saving} onChange={(e) => void patch({ priority: e.target.value })}>
            {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Type</span>
          <select value={ticket.type} disabled={saving} onChange={(e) => void patch({ type: e.target.value })}>
            {(Object.keys(TYPE_LABEL) as TicketType[]).map((ty) => <option key={ty} value={ty}>{TYPE_LABEL[ty]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Queue</span>
          <select value={ticket.queueId} disabled={saving || !queues.data} onChange={(e) => void patch({ queueId: e.target.value })}>
            {queues.data?.items.filter((q) => q.isActive || q.id === ticket.queueId).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Category</span>
          <select value={ticket.categoryId ?? ''} disabled={saving || !queue} onChange={(e) => void patch({ categoryId: e.target.value || null })}>
            <option value="">None</option>
            {queue?.categories.filter((c) => c.isActive || c.id === ticket.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      {ticket.priority !== 'urgent' && ticket.sla ? (
        <p className="field-hint sd-panel-pad">Changing priority recalculates both service-level targets from when the ticket was raised.</p>
      ) : null}
    </section>
  );
}

function Attachments({ ticket, apiBase, onDone, onError }: { ticket: Ticket; apiBase: string; onDone: () => void; onError: (m: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [internal, setInternal] = useState(false);
  const portal = apiBase === '/portal';
  const canAdd = ticket.permissions.canReply && ticket.status !== 'closed';

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true); onError(null);
    try {
      for (const file of Array.from(files)) {
        const stored = await uploadWorkspaceFile<{ id: string }>(file, portal ? { purpose: 'portal_submission' } : {});
        if (portal) await api.post(`/portal/tickets/${ticket.id}/attachments`, { fileId: stored.id });
        else await api.post(`/service/tickets/${ticket.id}/attachments`, { fileId: stored.id, visibility: internal ? 'internal' : 'public' });
      }
    } catch (err) {
      onError(err instanceof ApiError || err instanceof Error ? err.message : 'The file was not attached.');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
      onDone();
    }
  };

  const open = async (fileId: string) => {
    onError(null);
    try {
      const link = portal
        ? await api.get<{ url: string }>(`/portal/tickets/${ticket.id}/attachments/${fileId}/download`)
        : await api.get<{ url: string }>(`/service/tickets/${ticket.id}/attachments/${fileId}/download`);
      await openExternal(link.url);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'That file could not be opened.');
    }
  };

  if (ticket.attachments.length === 0 && !canAdd) return null;
  return (
    <section className="cc-panel" aria-label="Attachments">
      <header><Paperclip size={14} aria-hidden="true" /><h3>Attachments</h3></header>
      {ticket.attachments.length > 0 ? (
        <ul className="cc-rows">
          {ticket.attachments.map((a) => (
            <li key={a.fileId}>
              <button type="button" className="cc-row sd-file" onClick={() => void open(a.fileId)}>
                <span className="cc-row-main">
                  <strong>{a.name}</strong>
                  <span>{formatBytes(a.sizeBytes)} · {a.addedByName}</span>
                </span>
                {a.visibility === 'internal' ? <span className="sd-internal-tag"><Lock size={11} aria-hidden="true" /> Internal</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {canAdd ? (
        <div className="sd-panel-pad sd-upload">
          <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          <button type="button" className="ghost-button" disabled={uploading} onClick={() => input.current?.click()}>
            <Paperclip size={14} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Attach files'}
          </button>
          {ticket.permissions.canWork ? (
            <label className="sd-check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal only</label>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LinkTask({ ticket, onDone, onError }: { ticket: Ticket; onDone: () => void; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const projects = useQuery<{ items: { id: string; name: string; key: string }[] }>(open ? '/projects' : null, (signal) => api.get('/projects', signal));
  const [projectId, setProjectId] = useState('');
  const [pending, setPending] = useState(false);
  if (!open) {
    return <button type="button" className="sd-link-button" onClick={() => setOpen(true)}><Link2 size={13} aria-hidden="true" /> Create a task</button>;
  }
  return (
    <div className="sd-inline">
      <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">{projects.data ? 'Choose a project' : 'Loading projects…'}</option>
        {projects.data?.items.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
      </select>
      <button type="button" className="primary-button" disabled={!projectId || pending} onClick={async () => {
        setPending(true); onError(null);
        try { await api.post(`/service/tickets/${ticket.id}/task`, { projectId }); setOpen(false); }
        catch (err) { onError(err instanceof ApiError ? err.message : 'The task was not created.'); }
        finally { setPending(false); onDone(); }
      }}>Create</button>
    </div>
  );
}

function Feedback({ ticket, apiBase, onDone }: { ticket: Ticket; apiBase: string; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const labels = useMemo(() => ['', 'Very poor', 'Poor', 'Okay', 'Good', 'Excellent'], []);
  return (
    <section className="cc-panel" aria-label="Rate this support">
      <header><h3>How did we do?</h3></header>
      <form className="sd-panel-pad sd-feedback" onSubmit={async (e) => {
        e.preventDefault();
        if (!rating) return;
        try {
          const input = { rating, comment: comment || null };
          if (apiBase === '/portal') await api.post(`/portal/tickets/${ticket.id}/feedback`, input);
          else await api.post(`/service/tickets/${ticket.id}/feedback`, input);
          onDone();
        }
        catch (err) { setError(err instanceof ApiError ? err.message : 'Your rating was not saved.'); }
      }}>
        <div className="sd-stars" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} – ${labels[n]}`}
              className={`sd-star ${n <= rating ? 'is-on' : ''}`} onClick={() => setRating(n)}>
              <Star size={20} aria-hidden="true" />
            </button>
          ))}
          <span className="field-hint">{labels[rating]}</span>
        </div>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything we should know? (optional)" maxLength={2000} />
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <button type="submit" className="primary-button" disabled={!rating}>Submit rating</button>
      </form>
    </section>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="sd-stars" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={16} className={`sd-star-static ${n <= value ? 'is-on' : ''}`} aria-hidden="true" />)}
    </span>
  );
}

function FormAnswer({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

function ProblemRecord({ ticket, onDone, onError }: { ticket: Ticket; onDone: () => void; onError: (m: string | null) => void }) {
  const [rootCause, setRootCause] = useState(ticket.rootCause ?? '');
  const [workaround, setWorkaround] = useState(ticket.workaround ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = rootCause !== (ticket.rootCause ?? '') || workaround !== (ticket.workaround ?? '');
  return (
    <section className="cc-panel" aria-label="Problem record">
      <header><h3>Problem record</h3><span className="cc-meta">{ticket.incidents.length} linked {ticket.incidents.length === 1 ? 'incident' : 'incidents'}</span></header>
      <div className="sd-panel-pad sd-editor">
        {ticket.permissions.canWork ? (
          <>
            <label className="field"><span>Root cause</span><textarea rows={3} value={rootCause} onChange={(e) => setRootCause(e.target.value)} maxLength={20000} placeholder="What actually went wrong" /></label>
            <label className="field"><span>Known workaround</span><textarea rows={2} value={workaround} onChange={(e) => setWorkaround(e.target.value)} maxLength={20000} placeholder="What people can do until it is fixed" /></label>
            <div className="dialog-actions">
              <button type="button" className="primary-button" disabled={!dirty || saving} onClick={async () => {
                setSaving(true); onError(null);
                try { await api.patch(`/service/tickets/${ticket.id}/problem-record`, { rootCause: rootCause || null, workaround: workaround || null }); }
                catch (err) { onError(err instanceof ApiError ? err.message : 'The problem record was not saved.'); }
                finally { setSaving(false); onDone(); }
              }}>Save problem record</button>
            </div>
          </>
        ) : (
          <dl className="sd-props">
            <dt>Root cause</dt><dd className="sd-body">{ticket.rootCause ?? 'Not yet known'}</dd>
            <dt>Workaround</dt><dd className="sd-body">{ticket.workaround ?? 'None recorded'}</dd>
          </dl>
        )}
        {ticket.incidents.length > 0 ? (
          <ul className="cc-rows">
            {ticket.incidents.map((i) => (
              <li key={i.id}><Link to={`/service/tickets/${i.id}`} className="cc-row"><span className="sd-ref">{i.ref}</span><span className="cc-row-main"><strong>{i.subject}</strong></span><StatusBadge status={i.status} /></Link></li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function ProblemLink({ ticket, onDone, onError }: { ticket: Ticket; onDone: () => void; onError: (m: string | null) => void }) {
  const problems = useQuery<{ items: TicketSummaryLite[] }>(ticket.permissions.canWork && !ticket.problem ? '/service/tickets?limit=100&status=active' : null,
    (signal) => api.get('/service/tickets?limit=100&status=active', signal));
  const [choice, setChoice] = useState('');
  const options = (problems.data?.items ?? []).filter((p) => p.type === 'problem' && p.id !== ticket.id);
  const set = async (problemId: string | null) => {
    onError(null);
    try { await api.put(`/service/tickets/${ticket.id}/problem`, { problemId }); }
    catch (err) { onError(err instanceof ApiError ? err.message : 'The problem link was not saved.'); }
    onDone();
  };
  return (
    <section className="cc-panel" aria-label="Problem">
      <header><h3>Underlying problem</h3></header>
      {ticket.problem ? (
        <div className="sd-link-row">
          <Link to={`/service/tickets/${ticket.problem.id}`} className="cc-row"><span className="sd-ref">{ticket.problem.ref}</span><span className="cc-row-main"><strong>{ticket.problem.subject}</strong></span></Link>
          {ticket.permissions.canWork ? <button type="button" className="icon-button" aria-label="Remove problem link" onClick={() => void set(null)}><X size={14} /></button> : null}
        </div>
      ) : (
        <div className="sd-panel-pad sd-inline">
          <select aria-label="Problem ticket" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">{options.length ? 'Link to a problem…' : 'No open problem tickets'}</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.subject}</option>)}
          </select>
          <button type="button" className="ghost-button" disabled={!choice} onClick={() => void set(choice)}>Link</button>
        </div>
      )}
    </section>
  );
}

type TicketSummaryLite = { id: string; ref: string; subject: string; type: string };

function AssetsPanel({ ticket, onDone, onError }: { ticket: Ticket; onDone: () => void; onError: (m: string | null) => void }) {
  const { can } = useSession();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const key = `/assets${search ? `?q=${encodeURIComponent(search)}` : ''}`;
  const assets = useQuery<{ items: { id: string; asset_tag: string; name: string; assignee_name: string | null }[] }>(adding && can('asset.read') ? key : null, (signal) => api.get(key, signal));
  const act = async (fn: () => Promise<unknown>) => {
    onError(null);
    try { await fn(); } catch (err) { onError(err instanceof ApiError ? err.message : 'That did not go through.'); }
    onDone();
  };
  return (
    <section className="cc-panel" aria-label="Devices">
      <header><h3>Devices</h3>{ticket.permissions.canWork && can('asset.read') && !adding ? <button type="button" className="sd-link-button" onClick={() => setAdding(true)}>Link device</button> : null}</header>
      {ticket.assets.length === 0 && !adding ? <p className="cc-empty">No devices linked.</p> : null}
      {ticket.assets.length > 0 ? (
        <ul className="cc-rows">
          {ticket.assets.map((a) => (
            <li key={a.id} className="sd-link-row">
              <span className="cc-row"><span className="sd-ref">{a.tag}</span><span className="cc-row-main"><strong>{a.name}</strong><span>{a.warrantyUntil ? `Warranty until ${formatDate(a.warrantyUntil)}${a.warrantyUntil < new Date().toISOString().slice(0, 10) ? ' (expired)' : ''}` : 'No warranty recorded'}</span></span></span>
              {ticket.permissions.canWork ? <button type="button" className="icon-button" aria-label={`Unlink ${a.tag}`} onClick={() => void act(() => api.delete(`/service/tickets/${ticket.id}/assets/${a.id}`))}><X size={14} /></button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <div className="sd-panel-pad sd-editor">
          <input type="search" aria-label="Search devices" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tag, name or serial" autoFocus />
          <ul className="cc-rows sd-pick-list">
            {(assets.data?.items ?? []).filter((a) => !ticket.assets.some((l) => l.id === a.id)).slice(0, 8).map((a) => (
              <li key={a.id}><button type="button" className="cc-row sd-file" onClick={() => void act(() => api.post(`/service/tickets/${ticket.id}/assets`, { assetId: a.id }))}>
                <span className="sd-ref">{a.asset_tag}</span><span className="cc-row-main"><strong>{a.name}</strong><span>{a.assignee_name ?? 'Unassigned'}</span></span>
              </button></li>
            ))}
          </ul>
          <button type="button" className="ghost-button" onClick={() => setAdding(false)}>Done</button>
        </div>
      ) : null}
    </section>
  );
}

function ArticlesPanel({ ticket, portal, onDone, onError }: { ticket: Ticket; portal: boolean; onDone: () => void; onError: (m: string | null) => void }) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState(ticket.subject);
  // Matches any word, like the suggestions when raising a ticket: a subject is a sentence, not a query.
  const key = `/service/knowledge/suggest?q=${encodeURIComponent(query)}`;
  const results = useQuery<{ items: { id: string; title: string; audience: string }[] }>(searching && query.trim().length > 2 ? key : null, (signal) => api.get(key, signal));
  const base = portal ? '/portal/knowledge' : '/service/knowledge';
  return (
    <section className="cc-panel" aria-label="Help articles">
      <header><h3>Help articles</h3>{ticket.permissions.canWork && !searching ? <button type="button" className="sd-link-button" onClick={() => setSearching(true)}>Link article</button> : null}</header>
      {ticket.articles.length === 0 && !searching ? <p className="cc-empty">No articles linked.</p> : null}
      {ticket.articles.length > 0 ? (
        <ul className="cc-rows">
          {ticket.articles.map((a) => (
            <li key={a.id}><Link to={`${base}/${a.id}`} className="cc-row"><span className="cc-row-main"><strong>{a.title}</strong>{!portal ? <span>{a.audience === 'public' ? 'Requester can read it' : 'Internal only'}</span> : null}</span></Link></li>
          ))}
        </ul>
      ) : null}
      {searching ? (
        <div className="sd-panel-pad sd-editor">
          <input type="search" aria-label="Search articles" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          {results.data && results.data.items.length === 0 ? <p className="field-hint">No published articles match.</p> : null}
          <ul className="cc-rows sd-pick-list">
            {(results.data?.items ?? []).filter((a) => !ticket.articles.some((l) => l.id === a.id)).map((a) => (
              <li key={a.id}><button type="button" className="cc-row sd-file" onClick={async () => {
                onError(null);
                try { await api.post(`/service/tickets/${ticket.id}/articles`, { articleId: a.id }); }
                catch (err) { onError(err instanceof ApiError ? err.message : 'The article was not linked.'); }
                onDone();
              }}><span className="cc-row-main"><strong>{a.title}</strong><span>{a.audience === 'public' ? 'Clients too' : 'Internal'}</span></span></button></li>
            ))}
          </ul>
          <button type="button" className="ghost-button" onClick={() => setSearching(false)}>Done</button>
        </div>
      ) : null}
    </section>
  );
}
