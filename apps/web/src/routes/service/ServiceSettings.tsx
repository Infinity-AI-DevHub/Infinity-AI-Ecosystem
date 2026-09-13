/**
 * Service desk settings: queues, who works them, their categories, and SLA targets.
 *
 * Only for `service.manage`. The server refuses everything here for anyone else; the
 * page shows a plain explanation rather than a form that would fail on save.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowLeft, Copy, Mail, Plus, Trash2 } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorState, Forbidden, Loading } from '../../components/States';
import { PeoplePicker } from '../../components/PeoplePicker';
import { formatMinutes, PRIORITY_LABEL, type FormField, type Queue, type TicketPriority } from '../../lib/service';
import { formatDateTime, relativeTime } from '../../lib/format';
import '../../styles/command.css';
import '../../styles/service.css';

type Policy = { priority: TicketPriority; firstResponseMinutes: number; resolutionMinutes: number; useBusinessHours: boolean; isDefault: boolean };
type Person = { id: string; displayName: string; email: string };

export default function ServiceSettings() {
  const { can } = useSession();
  const queues = useQuery<{ items: Queue[] }>('/service/queues', (signal) => api.get('/service/queues', signal));
  const people = useQuery<Paged<Person>>(can('user.read') ? '/users?limit=100' : null, (signal) => api.get('/users?limit=100', signal));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!selected && queues.data?.items[0]) setSelected(queues.data.items[0].id);
  }, [queues.data, selected]);

  if (!can('service.manage')) return <Forbidden message="Only service desk administrators can change these settings." />;
  if (queues.loading && !queues.data) return <Loading label="Loading settings" rows={5} />;
  if (queues.error && !queues.data) return <ErrorState error={queues.error} onRetry={queues.reload} />;

  const queue = queues.data!.items.find((q) => q.id === selected) ?? null;

  return (
    <div className="module-page cc-page">
      <Link to="/service" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Service desk</Link>
      <header className="cc-header">
        <div>
          <p className="cc-eyebrow">Service</p>
          <h2>Service desk settings</h2>
        </div>
      </header>

      <div className="sd-settings-grid">
        <section className="cc-panel" aria-label="Queues">
          <header>
            <h3>Queues</h3>
            <button type="button" className="ghost-button" onClick={() => setCreating(true)}><Plus size={14} aria-hidden="true" /> New queue</button>
          </header>
          {creating ? <NewQueue onDone={(id) => { setCreating(false); if (id) setSelected(id); invalidate('/service/queues'); }} /> : null}
          {queues.data!.items.length === 0 && !creating ? (
            <p className="cc-empty">No queues yet. A queue is where requests of one kind land - for example IT support, facilities, or client support.</p>
          ) : (
            <ul className="cc-rows">
              {queues.data!.items.map((q) => (
                <li key={q.id}>
                  <button type="button" className={`cc-row sd-queue-row ${q.id === selected ? 'is-selected' : ''}`} aria-pressed={q.id === selected} onClick={() => setSelected(q.id)}>
                    <span className="cc-row-main">
                      <strong>{q.name}</strong>
                      <span>{q.audience === 'client' ? 'Client portal' : 'Employees'} · {q.memberCount} {q.memberCount === 1 ? 'person' : 'people'} · {q.openCount} open</span>
                    </span>
                    {!q.isActive ? <span className="cc-tag">Inactive</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {queue ? <QueueEditor key={queue.id} queue={queue} people={people.data?.items ?? []} /> : (
          <Empty title="Choose a queue" description="Select a queue to change its members, categories and escalation contact." />
        )}
      </div>

      <SlaPolicies />
      <BusinessHours />
      <InboundEmail queues={queues.data!.items.filter((q) => q.isActive)} />
    </div>
  );
}

function NewQueue({ onDone }: { onDone: (id: string | null) => void }) {
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<'internal' | 'client'>('internal');
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="sd-panel-pad sd-inline-form" onSubmit={async (e) => {
      e.preventDefault(); setError(null);
      try { const created = await api.post<{ id: string }>('/service/queues', { name, audience }); onDone(created.id); }
      catch (err) { setError(err instanceof ApiError ? err.message : 'The queue was not created.'); }
    }}>
      <label className="field"><span>Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required placeholder="IT support" /></label>
      <label className="field"><span>Who raises requests</span>
        <select value={audience} onChange={(e) => setAudience(e.target.value as 'internal' | 'client')}>
          <option value="internal">Employees</option>
          <option value="client">Clients, through the portal</option>
        </select>
      </label>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="ghost-button" onClick={() => onDone(null)}>Cancel</button>
        <button type="submit" className="primary-button">Create queue</button>
      </div>
    </form>
  );
}

function QueueEditor({ queue, people }: { queue: Queue; people: Person[] }) {
  const membersKey = `/service/queues/${queue.id}/members`;
  const members = useQuery<{ items: { id: string }[] }>(membersKey, (signal) => api.get(membersKey, signal));
  const [memberIds, setMemberIds] = useState<string[] | null>(null);
  const [name, setName] = useState(queue.name);
  const [description, setDescription] = useState(queue.description ?? '');
  const [escalation, setEscalation] = useState(queue.escalationUserId ?? '');
  const [audience, setAudience] = useState(queue.audience);
  const [category, setCategory] = useState('');
  const [formFor, setFormFor] = useState<Queue['categories'][number] | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (members.data && memberIds === null) setMemberIds(members.data.items.map((m) => m.id)); }, [members.data, memberIds]);

  const act = async (action: () => Promise<unknown>, ok: string) => {
    setSaving(true); setMessage(null);
    try { await action(); setMessage({ kind: 'ok', text: ok }); }
    catch (err) { setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'That change was not saved.' }); }
    finally { setSaving(false); invalidate('/service/queues'); invalidate(membersKey); }
  };

  const dirtyDetails = name !== queue.name || description !== (queue.description ?? '') || escalation !== (queue.escalationUserId ?? '') || audience !== queue.audience;
  const dirtyMembers = memberIds !== null && members.data && [...memberIds].sort().join() !== members.data.items.map((m) => m.id).sort().join();

  return (
    <section className="cc-panel" aria-label={`Queue ${queue.name}`}>
      <header><h3>{queue.name}</h3>
        <button type="button" className="ghost-button" disabled={saving}
          onClick={() => void act(() => api.patch(`/service/queues/${queue.id}`, { isActive: !queue.isActive }), queue.isActive ? 'Queue deactivated. Existing tickets stay open.' : 'Queue reactivated.')}>
          {queue.isActive ? 'Deactivate' : 'Reactivate'}
        </button>
      </header>
      <div className="sd-panel-pad sd-editor">
        <div className="sd-form-grid">
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
          <label className="field"><span>Who raises requests</span>
            <select value={audience} onChange={(e) => setAudience(e.target.value as 'internal' | 'client')}>
              <option value="internal">Employees</option>
              <option value="client">Clients, through the portal</option>
            </select>
          </label>
          <label className="field sd-span-2"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="What belongs in this queue" /></label>
          <label className="field sd-span-2"><span>Escalation contact</span>
            <select value={escalation} onChange={(e) => setEscalation(e.target.value)}>
              <option value="">Nobody - tell the queue</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
            <span className="field-hint">Told when a ticket here misses its resolution target, together with the assignee.</span>
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="primary-button" disabled={!dirtyDetails || saving || name.trim().length < 2}
            onClick={() => void act(() => api.patch(`/service/queues/${queue.id}`, { name, description: description || null, escalationUserId: escalation || null, audience }), 'Queue saved.')}>
            Save details
          </button>
        </div>

        <h4 className="sd-subhead">People who work this queue</h4>
        {memberIds === null ? <Loading rows={2} /> : (
          <>
            <PeoplePicker label="Queue members" people={people} selected={memberIds} onChange={setMemberIds} emptyHint="Nobody works this queue yet" />
            <div className="dialog-actions">
              <button type="button" className="primary-button" disabled={!dirtyMembers || saving}
                onClick={() => void act(() => api.put(`/service/queues/${queue.id}/members`, { userIds: memberIds }), 'Members saved.')}>
                Save members
              </button>
            </div>
          </>
        )}

        <h4 className="sd-subhead">Categories</h4>
        <ul className="sd-chips">
          {queue.categories.length === 0 ? <li className="field-hint">No categories. Requesters can still raise tickets without one.</li> : null}
          {queue.categories.map((c) => (
            <li key={c.id} className={`sd-chip ${c.isActive ? '' : 'is-off'}`}>
              {c.name}
              {c.formFields.length ? <span className="cc-tag">{c.formFields.length} fields</span> : null}
              <button type="button" className="sd-link-button" disabled={saving} onClick={() => setFormFor(c)}>Form</button>
              <button type="button" className="sd-link-button" disabled={saving}
                onClick={() => void act(() => api.patch(`/service/categories/${c.id}`, { isActive: !c.isActive }), c.isActive ? `${c.name} retired.` : `${c.name} restored.`)}>
                {c.isActive ? 'Retire' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
        <form className="sd-inline" onSubmit={(e) => {
          e.preventDefault();
          if (category.trim().length < 2) return;
          void act(async () => { await api.post(`/service/queues/${queue.id}/categories`, { name: category }); setCategory(''); }, 'Category added.');
        }}>
          <label className="visually-hidden" htmlFor="new-category">New category</label>
          <input id="new-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Hardware, Accounts, VPN" maxLength={120} />
          <button type="submit" className="ghost-button" disabled={saving || category.trim().length < 2}><Plus size={14} aria-hidden="true" /> Add</button>
        </form>
        {message ? <p className={message.kind === 'ok' ? 'field-hint sd-ok' : 'field-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}
      </div>
      {formFor ? <FormBuilder category={formFor} onClose={() => { setFormFor(null); invalidate('/service/queues'); }} /> : null}
    </section>
  );
}

const FIELD_TYPES: { id: FormField['type']; label: string }[] = [
  { id: 'text', label: 'Short text' }, { id: 'textarea', label: 'Long text' }, { id: 'number', label: 'Number' },
  { id: 'date', label: 'Date' }, { id: 'select', label: 'Choice' }, { id: 'checkbox', label: 'Yes / no' },
];

function FormBuilder({ category, onClose }: { category: Queue['categories'][number]; onClose: () => void }) {
  const [fields, setFields] = useState<(FormField & { optionsText?: string })[]>(
    category.formFields.map((f) => ({ ...f, optionsText: f.options?.join('\n') ?? '' })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (i: number, patch: Partial<FormField & { optionsText?: string }>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: number) => {
    const next = [...fields];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setFields(next);
  };

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog sd-dialog sd-form-builder" role="dialog" aria-modal="true" aria-labelledby="form-builder-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h3 id="form-builder-title">Request form: {category.name}</h3>
        <p className="field-hint">Asked when someone raises a ticket in this category. Answers are checked when the ticket is submitted.</p>
        {fields.length === 0 ? <p className="cc-empty">No fields yet. Requesters only give a subject and details.</p> : null}
        <ol className="sd-builder-list">
          {fields.map((f, i) => (
            <li key={i} className="cc-panel sd-panel-pad">
              <div className="sd-form-grid">
                <label className="field"><span>Label</span><input value={f.label} maxLength={120} onChange={(e) => update(i, { label: e.target.value, key: f.key || e.target.value })} placeholder="Asset tag" /></label>
                <label className="field"><span>Type</span>
                  <select value={f.type} onChange={(e) => update(i, { type: e.target.value as FormField['type'] })}>
                    {FIELD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </label>
                {f.type === 'select' ? (
                  <label className="field sd-span-2"><span>Choices, one per line</span><textarea rows={3} value={f.optionsText ?? ''} onChange={(e) => update(i, { optionsText: e.target.value })} /></label>
                ) : null}
                <label className="field sd-span-2"><span>Help text</span><input value={f.help ?? ''} maxLength={200} onChange={(e) => update(i, { help: e.target.value })} /></label>
              </div>
              <div className="sd-inline sd-builder-actions">
                <label className="sd-check"><input type="checkbox" checked={Boolean(f.required)} onChange={(e) => update(i, { required: e.target.checked })} /> Required</label>
                <button type="button" className="icon-button" aria-label={`Move ${f.label || 'field'} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                <button type="button" className="icon-button" aria-label={`Move ${f.label || 'field'} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                <button type="button" className="icon-button" aria-label={`Remove ${f.label || 'field'}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
              </div>
            </li>
          ))}
        </ol>
        <button type="button" className="ghost-button" disabled={fields.length >= 20} onClick={() => setFields([...fields, { key: '', label: '', type: 'text', required: false, optionsText: '' }])}>
          <Plus size={14} aria-hidden="true" /> Add field
        </button>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-button" disabled={saving} onClick={async () => {
            setSaving(true); setError(null);
            try {
              await api.put(`/service/categories/${category.id}/form`, {
                fields: fields.map((f) => ({
                  key: f.key || f.label, label: f.label, type: f.type, required: Boolean(f.required), help: f.help || undefined,
                  options: f.type === 'select' ? (f.optionsText ?? '').split('\n').map((o) => o.trim()).filter(Boolean) : undefined,
                })),
              });
              onClose();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'The form was not saved.');
              setSaving(false);
            }
          }}>Save form</button>
        </div>
      </div>
    </div>
  );
}

type InboundConfig = {
  configured: boolean; queueId: string | null; queueName: string | null; endpoint: string | null; secretFingerprint: string | null;
  isActive: boolean; lastReceivedAt: string | null; rotatedAt: string | null; secret?: string;
  recent: { from: string; subject: string | null; outcome: string; ticketId: string | null; detail: string | null; receivedAt: string }[];
};

const OUTCOME_TEXT: Record<string, string> = {
  created: 'Ticket created', replied: 'Added as reply', rejected_sender: 'Refused: unknown sender',
  rejected_closed: 'Refused: ticket closed', duplicate: 'Duplicate',
};

function InboundEmail({ queues }: { queues: Queue[] }) {
  const config = useQuery<InboundConfig>('/service/inbound-email', (signal) => api.get('/service/inbound-email', signal));
  const [queueId, setQueueId] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!config.data) return config.error ? <ErrorState error={config.error} onRetry={config.reload} /> : <Loading rows={2} />;
  const c = config.data;
  const target = queueId || c.queueId || queues[0]?.id || '';

  const rotate = async () => {
    setBusy(true); setError(null);
    try { const res = await api.post<InboundConfig>('/service/inbound-email/rotate', { queueId: target }); setSecret(res.secret ?? null); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Email-to-ticket was not set up.'); }
    finally { setBusy(false); invalidate('/service/inbound-email'); }
  };

  return (
    <section className="cc-panel" aria-label="Email to ticket">
      <header><Mail size={15} aria-hidden="true" /><h3>Email to ticket</h3>{c.configured ? <span className={`cc-tag ${c.isActive ? 'cc-tag-info' : ''}`}>{c.isActive ? 'On' : 'Paused'}</span> : null}</header>
      <div className="sd-panel-pad sd-editor">
        <p className="field-hint">
          Your mail system forwards each message to this endpoint as signed JSON. Messages from people in the workspace open tickets;
          replies with “[SD-123]” in the subject join that ticket. Mail from unknown senders is refused and logged below.
        </p>
        <div className="sd-inline">
          <label className="field"><span>New tickets go to</span>
            <select value={target} onChange={(e) => setQueueId(e.target.value)}>
              {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </label>
          {c.configured && queueId && queueId !== c.queueId ? (
            <button type="button" className="ghost-button" onClick={async () => { await api.patch('/service/inbound-email', { queueId }); invalidate('/service/inbound-email'); }}>Save queue</button>
          ) : null}
        </div>
        {c.configured ? (
          <dl className="sd-props">
            <dt>Endpoint</dt><dd><code className="sd-code">{c.endpoint}</code></dd>
            <dt>Secret</dt><dd>Fingerprint <code>{c.secretFingerprint}</code> · rotated {c.rotatedAt ? relativeTime(c.rotatedAt) : '—'}</dd>
            <dt>Headers</dt><dd><code>x-infinity-timestamp</code> (Unix seconds) and <code>x-infinity-signature</code> = hex HMAC-SHA256 of <code>timestamp.body</code></dd>
            <dt>Last message</dt><dd>{c.lastReceivedAt ? formatDateTime(c.lastReceivedAt) : 'Nothing received yet'}</dd>
          </dl>
        ) : null}
        {secret ? (
          <div className="auth-success" role="status">
            <div><strong>Copy this secret now</strong><p>It will not be shown again. Store it in your mail system's webhook settings.</p><code className="invitation-link">{secret}</code></div>
            <button type="button" className="ghost-button" onClick={() => navigator.clipboard?.writeText(secret)}><Copy size={14} aria-hidden="true" /> Copy</button>
            <button type="button" className="ghost-button" onClick={() => setSecret(null)}>Done</button>
          </div>
        ) : null}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {c.configured ? (
            <button type="button" className="ghost-button" onClick={async () => { await api.patch('/service/inbound-email', { isActive: !c.isActive }); invalidate('/service/inbound-email'); }}>{c.isActive ? 'Pause' : 'Resume'}</button>
          ) : null}
          <button type="button" className="primary-button" disabled={busy || !target} onClick={() => void rotate()}>{c.configured ? 'Rotate secret' : 'Set up email to ticket'}</button>
        </div>
        {c.recent.length > 0 ? (
          <>
            <h4 className="sd-subhead">Recent messages</h4>
            <ul className="cc-rows">
              {c.recent.map((m, i) => (
                <li key={i} className="cc-row">
                  <span className="cc-row-main"><strong>{m.subject ?? '(no subject)'}</strong><span>{m.from} · {relativeTime(m.receivedAt)}</span></span>
                  {m.ticketId ? <Link to={`/service/tickets/${m.ticketId}`} className={`cc-tag ${m.outcome.startsWith('rejected') ? 'cc-tag-critical' : 'cc-tag-info'}`}>{OUTCOME_TEXT[m.outcome] ?? m.outcome}</Link>
                    : <span className={`cc-tag ${m.outcome.startsWith('rejected') ? 'cc-tag-critical' : ''}`}>{OUTCOME_TEXT[m.outcome] ?? m.outcome}</span>}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}

function SlaPolicies() {
  const policies = useQuery<{ items: Policy[] }>('/service/sla-policies', (signal) => api.get('/service/sla-policies', signal));
  const [draft, setDraft] = useState<Record<string, { first: string; resolution: string; business: boolean }>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (policies.data) {
      setDraft(Object.fromEntries(policies.data.items.map((p) => [p.priority, { first: String(p.firstResponseMinutes), resolution: String(p.resolutionMinutes), business: p.useBusinessHours }])));
    }
  }, [policies.data]);

  if (!policies.data) return policies.error ? <ErrorState error={policies.error} onRetry={policies.reload} /> : <Loading rows={3} />;

  return (
    <section className="cc-panel" aria-label="Service level targets">
      <header><h3>Service level targets</h3></header>
      <p className="field-hint sd-panel-pad">Minutes from when a ticket is raised. Tick “Business hours” to count only the opening hours on the service calendar below. Every target pauses while a ticket is waiting on the requester.</p>
      <div className="sd-table-wrap">
        <table className="data-table">
          <thead><tr><th scope="col">Priority</th><th scope="col">First response (min)</th><th scope="col">Resolution (min)</th><th scope="col">Counting</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            {policies.data.items.map((p) => {
              const d = draft[p.priority] ?? { first: '', resolution: '', business: false };
              const changed = d.first !== String(p.firstResponseMinutes) || d.resolution !== String(p.resolutionMinutes) || d.business !== p.useBusinessHours;
              return (
                <tr key={p.priority}>
                  <th scope="row">{PRIORITY_LABEL[p.priority]}{p.isDefault ? <span className="sd-sub">Default</span> : null}</th>
                  <td>
                    <input type="number" min={1} aria-label={`${PRIORITY_LABEL[p.priority]} first response minutes`} value={d.first}
                      onChange={(e) => setDraft({ ...draft, [p.priority]: { ...d, first: e.target.value } })} />
                    <span className="sd-sub">{formatMinutes(Number(d.first) || null)}</span>
                  </td>
                  <td>
                    <input type="number" min={1} aria-label={`${PRIORITY_LABEL[p.priority]} resolution minutes`} value={d.resolution}
                      onChange={(e) => setDraft({ ...draft, [p.priority]: { ...d, resolution: e.target.value } })} />
                    <span className="sd-sub">{formatMinutes(Number(d.resolution) || null)}</span>
                  </td>
                  <td>
                    <label className="sd-check"><input type="checkbox" checked={d.business} onChange={(e) => setDraft({ ...draft, [p.priority]: { ...d, business: e.target.checked } })} /> Business hours</label>
                  </td>
                  <td>
                    <button type="button" className="ghost-button" disabled={!changed} onClick={async () => {
                      setMessage(null);
                      try {
                        await api.put(`/service/sla-policies/${p.priority}`, { firstResponseMinutes: Number(d.first), resolutionMinutes: Number(d.resolution), useBusinessHours: d.business });
                        setMessage({ kind: 'ok', text: `${PRIORITY_LABEL[p.priority]} targets saved. New tickets use them from now on.` });
                      } catch (err) {
                        setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'The targets were not saved.' });
                      }
                      invalidate('/service/sla-policies');
                    }}>Save</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {message ? <p className={`sd-panel-pad ${message.kind === 'ok' ? 'field-hint sd-ok' : 'field-error'}`} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}
    </section>
  );
}

const WEEKDAYS: [string, string][] = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['7', 'Sunday']];
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromTime = (v: string) => { const [h, m] = v.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };

type Calendar = { timezone: string; days: Record<string, [number, number]>; holidays: string[]; configured: boolean };

function BusinessHours() {
  const cal = useQuery<Calendar>('/service/calendar', (signal) => api.get('/service/calendar', signal));
  const [tz, setTz] = useState('');
  const [days, setDays] = useState<Record<string, [number, number] | null>>({});
  const [holidays, setHolidays] = useState<string[]>([]);
  const [newHoliday, setNewHoliday] = useState('');
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (cal.data && !ready) {
      setTz(cal.data.timezone);
      setDays(Object.fromEntries(WEEKDAYS.map(([k]) => [k, cal.data!.days[k] ?? null])));
      setHolidays(cal.data.holidays);
      setReady(true);
    }
  }, [cal.data, ready]);

  if (!ready) return cal.error ? <ErrorState error={cal.error} onRetry={cal.reload} /> : <Loading rows={3} />;
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];

  return (
    <section className="cc-panel" aria-label="Service calendar">
      <header><h3>Service calendar</h3>{!cal.data?.configured ? <span className="cc-tag">Default: weekdays 09:00–17:00 UTC</span> : null}</header>
      <div className="sd-panel-pad sd-editor">
        <p className="field-hint">Opening hours used by targets set to count business hours. Days that are unticked, and holidays, do not count.</p>
        <label className="field"><span>Timezone</span>
          {zones.length ? (
            <select value={tz} onChange={(e) => setTz(e.target.value)}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>
          ) : <input value={tz} onChange={(e) => setTz(e.target.value)} />}
        </label>
        <table className="data-table sd-hours">
          <thead><tr><th scope="col">Day</th><th scope="col">Open</th><th scope="col">From</th><th scope="col">Until</th></tr></thead>
          <tbody>
            {WEEKDAYS.map(([k, name]) => {
              const h = days[k];
              return (
                <tr key={k}>
                  <th scope="row">{name}</th>
                  <td><input type="checkbox" aria-label={`${name} open`} checked={Boolean(h)} onChange={(e) => setDays({ ...days, [k]: e.target.checked ? [540, 1020] : null })} /></td>
                  <td><input type="time" aria-label={`${name} opens`} disabled={!h} value={h ? toTime(h[0]) : ''} onChange={(e) => setDays({ ...days, [k]: [fromTime(e.target.value), h![1]] })} /></td>
                  <td><input type="time" aria-label={`${name} closes`} disabled={!h} value={h ? toTime(h[1]) : ''} onChange={(e) => setDays({ ...days, [k]: [h![0], fromTime(e.target.value)] })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <h4 className="sd-subhead">Holidays</h4>
        <ul className="sd-chips">
          {holidays.length === 0 ? <li className="field-hint">No holidays.</li> : holidays.map((d) => (
            <li key={d} className="sd-chip">{d}<button type="button" className="sd-link-button" onClick={() => setHolidays(holidays.filter((x) => x !== d))}>Remove</button></li>
          ))}
        </ul>
        <div className="sd-inline">
          <input type="date" aria-label="Holiday date" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} />
          <button type="button" className="ghost-button" disabled={!newHoliday} onClick={() => { setHolidays([...new Set([...holidays, newHoliday])].sort()); setNewHoliday(''); }}>Add holiday</button>
        </div>
        {message ? <p className={message.kind === 'ok' ? 'field-hint sd-ok' : 'field-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={async () => {
            setMessage(null);
            try {
              await api.put('/service/calendar', { timezone: tz, days: Object.fromEntries(Object.entries(days).filter(([, v]) => v)), holidays });
              setMessage({ kind: 'ok', text: 'Service calendar saved. New and recalculated targets use it.' });
            } catch (err) {
              setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'The calendar was not saved.' });
            }
            invalidate('/service/calendar');
          }}>Save calendar</button>
        </div>
      </div>
    </section>
  );
}
