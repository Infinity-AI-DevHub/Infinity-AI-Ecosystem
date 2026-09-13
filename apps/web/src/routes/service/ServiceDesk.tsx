/**
 * Service desk: the queue view.
 *
 * One page for both sides of the desk. Someone who works a queue lands on their own open
 * work and can switch to unassigned, breached, or everything they can see. Someone who
 * only raises requests sees their requests. The server decides what is in each list; the
 * views here only ask for a narrower slice of it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Plus, Settings2, Search as SearchIcon } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { useDebounced } from '../../lib/useDebounced';
import { relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import {
  PRIORITY_LABEL, PriorityBadge, SlaBadge, StatusBadge, STATUS_LABEL, TYPE_LABEL,
  type Queue, type TicketPriority, type TicketStatus, type TicketSummary, type TicketType,
} from '../../lib/service';
import '../../styles/command.css';
import '../../styles/service.css';

type View = 'mine' | 'unassigned' | 'breached' | 'all' | 'requested';

export default function ServiceDesk() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queues = useQuery<{ items: Queue[] }>('/service/queues', (signal) => api.get('/service/queues', signal));

  const isWorker = can('ticket.work') || (queues.data?.items.some((q) => q.isMember) ?? false);
  const canSeeAll = isWorker || can('ticket.read');
  const view = (params.get('view') as View | null) ?? (isWorker ? 'mine' : 'requested');
  const queueId = params.get('queue') ?? '';
  const status = params.get('status') ?? 'active';
  const priority = params.get('priority') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 250);
  const [creating, setCreating] = useState(false);
  const [extra, setExtra] = useState<TicketSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMessage, setBulkMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const { session } = useSession();
  const [cursor, setCursor] = useState<string | null>(null);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => { set('q', q); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);

  const apiView = view === 'mine' ? 'assigned' : view === 'all' ? '' : view;
  const listKey = `/service/tickets?limit=50${apiView ? `&view=${apiView}` : ''}${queueId ? `&queueId=${queueId}` : ''}`
    + `${status ? `&status=${status}` : ''}${priority ? `&priority=${priority}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const tickets = useQuery<Paged<TicketSummary>>(queues.data ? listKey : null, (signal) => api.get(listKey, signal));
  useEffect(() => { setExtra([]); setCursor(tickets.data?.nextCursor ?? null); }, [tickets.data]);
  useEffect(() => { setSelected(new Set()); }, [listKey]);

  const applyBulk = async (changes: Record<string, unknown>, label: string) => {
    setBulkMessage(null);
    try {
      const res = await api.patch<{ updated: number; failed: { id: string; error: string }[] }>('/service/tickets/bulk', { ids: [...selected], ...changes });
      setBulkMessage(res.failed.length
        ? { kind: 'error', text: `${label}: ${res.updated} updated, ${res.failed.length} not changed - ${res.failed[0]!.error}` }
        : { kind: 'ok', text: `${label}: ${res.updated} ${res.updated === 1 ? 'ticket' : 'tickets'} updated` });
      setSelected(new Set());
    } catch (err) {
      setBulkMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'The change was not applied.' });
    }
    invalidate('/service/tickets');
  };

  const rows = useMemo(() => [...(tickets.data?.items ?? []), ...extra], [tickets.data, extra]);

  const loadMore = async () => {
    if (!cursor) return;
    const next = await api.get<Paged<TicketSummary>>(`${listKey}&cursor=${encodeURIComponent(cursor)}`);
    setExtra((e) => [...e, ...next.items]);
    setCursor(next.nextCursor);
  };

  const views: { id: View; label: string; show: boolean }[] = [
    { id: 'mine', label: 'Assigned to me', show: isWorker },
    { id: 'unassigned', label: 'Unassigned', show: isWorker },
    { id: 'breached', label: 'SLA breached', show: canSeeAll },
    { id: 'all', label: canSeeAll ? 'All tickets' : 'All I can see', show: canSeeAll },
    { id: 'requested', label: 'My requests', show: true },
  ];

  if (queues.loading && !queues.data) return <Loading label="Loading the service desk" rows={6} />;
  if (queues.error && !queues.data) return <ErrorState error={queues.error} onRetry={queues.reload} />;
  const activeQueues = queues.data!.items.filter((q) => q.isActive);

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div>
          <p className="cc-eyebrow">Service</p>
          <h2>Service desk</h2>
        </div>
        <div className="cc-header-side">
          {isWorker || can('ticket.read') ? (
            <Link to="/service/analytics" className="ghost-button"><BarChart3 size={15} aria-hidden="true" /> Analytics</Link>
          ) : null}
          {can('service.manage') ? (
            <Link to="/service/settings" className="ghost-button"><Settings2 size={15} aria-hidden="true" /> Settings</Link>
          ) : null}
          <button type="button" className="primary-button" onClick={() => setCreating(true)} disabled={activeQueues.length === 0}>
            <Plus size={15} aria-hidden="true" /> New ticket
          </button>
        </div>
      </header>

      {activeQueues.length === 0 ? (
        <Empty title="The service desk has no queues yet"
          description={can('service.manage') ? 'Create a queue, add the people who work it, and requests can start coming in.' : 'An administrator needs to set up a queue before requests can be raised.'}
          action={can('service.manage') ? <Link className="primary-button" to="/service/settings">Set up queues</Link> : undefined} />
      ) : (
        <>
          <div className="sd-toolbar">
            <div className="tab-row" role="tablist" aria-label="Ticket views">
              {views.filter((v) => v.show).map((v) => (
                <button key={v.id} type="button" role="tab" aria-selected={view === v.id}
                  className={`tab ${view === v.id ? 'tab-active' : ''}`} onClick={() => set('view', v.id)}>{v.label}</button>
              ))}
            </div>
            <div className="sd-filters">
              <label className="sd-search">
                <SearchIcon size={14} aria-hidden="true" />
                <span className="visually-hidden">Search tickets</span>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Subject or SD-number" />
              </label>
              {canSeeAll ? (
                <select aria-label="Queue" value={queueId} onChange={(e) => set('queue', e.target.value)}>
                  <option value="">All queues</option>
                  {queues.data!.items.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                </select>
              ) : null}
              <select aria-label="Status" value={status} onChange={(e) => set('status', e.target.value)}>
                <option value="active">Open work</option>
                <option value="">Any status</option>
                {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              <select aria-label="Priority" value={priority} onChange={(e) => set('priority', e.target.value)}>
                <option value="">Any priority</option>
                {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </div>
          </div>

          {isWorker && selected.size > 0 ? (
            <div className="sd-bulk" role="region" aria-label="Bulk actions">
              <strong>{selected.size} selected</strong>
              <button type="button" className="ghost-button" onClick={() => void applyBulk({ assigneeId: session?.user?.id }, 'Assigned to you')}>Assign to me</button>
              <select aria-label="Set status" value="" onChange={(e) => { if (e.target.value) void applyBulk({ status: e.target.value }, `Status ${STATUS_LABEL[e.target.value as TicketStatus]}`); }}>
                <option value="">Set status…</option>
                {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s2) => <option key={s2} value={s2}>{STATUS_LABEL[s2]}</option>)}
              </select>
              <select aria-label="Set priority" value="" onChange={(e) => { if (e.target.value) void applyBulk({ priority: e.target.value }, `Priority ${PRIORITY_LABEL[e.target.value as TicketPriority]}`); }}>
                <option value="">Set priority…</option>
                {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p2) => <option key={p2} value={p2}>{PRIORITY_LABEL[p2]}</option>)}
              </select>
              <select aria-label="Move to queue" value="" onChange={(e) => { if (e.target.value) void applyBulk({ queueId: e.target.value }, 'Moved'); }}>
                <option value="">Move to queue…</option>
                {activeQueues.map((q2) => <option key={q2.id} value={q2.id}>{q2.name}</option>)}
              </select>
              <button type="button" className="sd-link-button" onClick={() => setSelected(new Set())}>Clear selection</button>
            </div>
          ) : null}
          {bulkMessage ? <p className={bulkMessage.kind === 'ok' ? 'field-hint sd-ok' : 'field-error'} role={bulkMessage.kind === 'ok' ? 'status' : 'alert'}>{bulkMessage.text}</p> : null}

          {tickets.loading && !tickets.data ? <Loading label="Loading tickets" rows={6} />
            : tickets.error && !tickets.data ? <ErrorState error={tickets.error} onRetry={tickets.reload} />
            : rows.length === 0 ? (
              <Empty title="No tickets here"
                description={view === 'mine' ? 'Nothing is assigned to you. Check Unassigned for work waiting to be picked up.' : 'Nothing matches this view and these filters.'} />
            ) : (
              <div className="sd-table-wrap">
                <table className="data-table sd-table">
                  <thead>
                    <tr>
                      {isWorker ? (
                        <th scope="col" className="sd-select-cell">
                          <input type="checkbox" aria-label="Select all tickets shown"
                            checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                            onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                        </th>
                      ) : null}
                      <th scope="col">Ticket</th>
                      <th scope="col">Requester</th>
                      {canSeeAll ? <th scope="col">Queue</th> : null}
                      <th scope="col">Priority</th>
                      <th scope="col">Status</th>
                      <th scope="col">Assignee</th>
                      <th scope="col">SLA</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id} className={`sd-row ${selected.has(t.id) ? 'is-selected' : ''}`} onClick={() => navigate(`/service/tickets/${t.id}`)}>
                        {isWorker ? (
                          <td className="sd-select-cell" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" aria-label={`Select ${t.ref}`} checked={selected.has(t.id)}
                              onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(t.id); else next.delete(t.id); setSelected(next); }} />
                          </td>
                        ) : null}
                        <th scope="row">
                          <Link to={`/service/tickets/${t.id}`} className="sd-subject" onClick={(e) => e.stopPropagation()}>
                            <span className="sd-ref">{t.ref}</span>
                            <span>{t.subject}</span>
                          </Link>
                          <span className="sd-sub">{TYPE_LABEL[t.type]}{t.categoryName ? ` · ${t.categoryName}` : ''}{t.channel === 'portal' ? ' · Client portal' : ''}</span>
                        </th>
                        <td>
                          <span className="sd-cell-main">{t.requesterName}</span>
                          {t.clientName ? <span className="sd-sub">{t.clientName}</span> : null}
                        </td>
                        {canSeeAll ? <td>{t.queueName}</td> : null}
                        <td><PriorityBadge priority={t.priority} /></td>
                        <td><StatusBadge status={t.status} /></td>
                        <td>{t.assigneeName ?? <span className="sd-muted">Unassigned</span>}</td>
                        <td><SlaBadge ticket={t} /></td>
                        <td className="sd-muted"><time dateTime={t.updatedAt}>{relativeTime(t.updatedAt)}</time></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {cursor ? <button type="button" className="ghost-button nc-more" onClick={() => void loadMore()}>Load more</button> : null}
              </div>
            )}
        </>
      )}

      {creating ? (
        <NewTicketDialog queues={activeQueues} isWorker={isWorker}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); invalidate('/service/tickets'); navigate(`/service/tickets/${id}`); }} />
      ) : null}
    </div>
  );
}

function NewTicketDialog({ queues, isWorker, onClose, onCreated }: {
  queues: Queue[]; isWorker: boolean; onClose: () => void; onCreated: (id: string) => void;
}) {
  const { can } = useSession();
  // A requester only sees queues that take employee requests; a worker sees all.
  const offered = queues.filter((q) => isWorker || q.audience === 'internal');
  const [queueId, setQueueId] = useState(offered[0]?.id ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [type, setType] = useState<TicketType>('request');
  const [requesterId, setRequesterId] = useState('');
  const [clientOrgId, setClientOrgId] = useState('');
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = offered.find((q) => q.id === queueId);
  const category = queue?.categories.find((c) => c.id === categoryId);
  const fields = category?.formFields ?? [];
  // Articles that might already answer this, while the subject is being typed.
  const suggestText = useDebounced(`${subject} ${description.slice(0, 200)}`.trim(), 400);
  const suggestions = useQuery<{ items: { id: string; title: string; summary: string }[] }>(
    suggestText.length > 6 ? `/service/knowledge/suggest?q=${encodeURIComponent(suggestText)}` : null,
    (signal) => api.get(`/service/knowledge/suggest?q=${encodeURIComponent(suggestText)}`, signal));
  const people = useQuery<Paged<{ id: string; displayName: string; email: string }>>(isWorker && can('user.read') ? '/users?limit=100' : null,
    (signal) => api.get('/users?limit=100', signal));
  const clients = useQuery<{ items: { id: string; name: string }[] }>(isWorker && can('external_org.read') ? '/external/organizations' : null,
    (signal) => api.get('/external/organizations', signal));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true); setError(null);
    try {
      const created = await api.post<{ id: string }>('/service/tickets', {
        subject, description, priority, type, queueId,
        categoryId: categoryId || null,
        requesterId: requesterId || null,
        clientOrgId: clientOrgId || null,
        formAnswers: fields.length ? Object.fromEntries(fields.map((f) => [f.key, answers[f.key] ?? (f.type === 'checkbox' ? false : '')]).filter(([, v]) => v !== '')) : undefined,
      });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The ticket could not be created. Try again.');
      setPending(false);
    }
  };

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="new-ticket-title"
        onClick={(e) => e.stopPropagation()} onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h3 id="new-ticket-title">New ticket</h3>
        <div className="sd-form-grid">
          <label className="field">
            <span>Queue</span>
            <select value={queueId} onChange={(e) => { setQueueId(e.target.value); setCategoryId(''); }} required>
              {offered.map((q) => <option key={q.id} value={q.id}>{q.name}{q.audience === 'client' ? ' (clients)' : ''}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Category</span>
            <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setAnswers({}); }} disabled={!queue?.categories.some((c) => c.isActive)}>
              <option value="">{queue?.categories.some((c) => c.isActive) ? 'Choose a category' : 'No categories'}</option>
              {queue?.categories.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field sd-span-2">
            <span>Subject</span>
            <input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} minLength={3} maxLength={300} required placeholder="What do you need help with?" />
          </label>
          <label className="field sd-span-2">
            <span>Details</span>
            <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={20000}
              placeholder="What happened, what you expected, and anything you have already tried." />
          </label>
          {suggestions.data && suggestions.data.items.length > 0 ? (
            <div className="sd-span-2 sd-suggest" role="status">
              <strong>These articles might answer it</strong>
              <ul>
                {suggestions.data.items.slice(0, 3).map((a) => (
                  <li key={a.id}><Link to={`/service/knowledge/${a.id}`}>{a.title}</Link><span>{a.summary}</span></li>
                ))}
              </ul>
            </div>
          ) : null}
          {fields.map((f) => (
            <label key={f.key} className={`field ${f.type === 'textarea' ? 'sd-span-2' : ''} ${f.type === 'checkbox' ? 'sd-check-field' : ''}`}>
              <span>{f.label}{f.required ? ' *' : ''}</span>
              {f.type === 'select' ? (
                <select value={String(answers[f.key] ?? '')} required={f.required} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })}>
                  <option value="">Choose…</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea rows={3} value={String(answers[f.key] ?? '')} required={f.required} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />
              ) : f.type === 'checkbox' ? (
                <span className="sd-check"><input type="checkbox" checked={Boolean(answers[f.key])} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.checked })} /> Yes</span>
              ) : (
                <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={String(answers[f.key] ?? '')} required={f.required}
                  onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />
              )}
              {f.help ? <span className="field-hint">{f.help}</span> : null}
            </label>
          ))}
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as TicketType)}>
              {(Object.keys(TYPE_LABEL) as TicketType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
              {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          {people.data ? (
            <label className="field">
              <span>On behalf of</span>
              <select value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>
                <option value="">Myself</option>
                {people.data.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </label>
          ) : null}
          {clients.data ? (
            <label className="field">
              <span>Client</span>
              <select value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)}>
                <option value="">No client</option>
                {clients.data.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={pending || !queueId}>{pending ? 'Creating…' : 'Create ticket'}</button>
        </div>
      </form>
    </div>
  );
}
