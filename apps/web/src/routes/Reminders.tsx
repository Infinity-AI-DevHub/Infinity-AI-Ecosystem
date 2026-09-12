/**
 * Reminders.
 *
 * Grouped by how urgent they are rather than listed by date, because the question
 * somebody opens this page with is "is anything about to bite me", not "what is my
 * calendar". Overdue first, then the ones already nagging, then everything still quiet.
 */
import { useState } from 'react';
import {
  AlertTriangle, BellRing, CalendarClock, Check, Clock, Pencil, Plus, RefreshCw, Trash2,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { invalidate, useQuery } from '../lib/query';
import { AsyncSection, Empty } from '../components/States';
import { PeoplePicker } from '../components/PeoplePicker';
import { useNotify } from '../lib/notify';
import { useConfirm } from '../components/Prompt';
import { formatDate } from '../lib/format';

type Reminder = {
  id: string;
  title: string;
  notes: string | null;
  kind: 'task' | 'payment' | 'renewal' | 'other';
  dueOn: string;
  leadDays: number;
  remindFrom: string;
  repeatEvery: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  repeatInterval: number;
  amount: number | null;
  currency: string | null;
  status: string;
  snoozedUntil: string | null;
  ownerName: string | null;
  watchers: number;
};

const KIND_WORDS: Record<string, string> = {
  task: 'To do', payment: 'Payment', renewal: 'Renewal', other: 'Reminder',
};

/** `today` as the same kind of plain day string the server stores. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86_400_000);
}

/** "in 3 days", "today", "4 days overdue" — the only part most people read. */
function whenText(dueOn: string): string {
  const days = daysBetween(today(), dueOn);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return '1 day overdue';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days overdue`;
}

function repeatText(reminder: Reminder): string | null {
  if (reminder.repeatEvery === 'none') return null;
  const every = reminder.repeatInterval > 1 ? `every ${reminder.repeatInterval} ` : '';
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[reminder.repeatEvery];
  return reminder.repeatInterval > 1 ? `Repeats ${every}${unit}s` : `Repeats ${unit}ly`;
}

export default function Reminders() {
  const [creating, setCreating] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const key = `/reminders${showDone ? '?includeDone=true' : ''}`;
  const reminders = useQuery<{ items: Reminder[] }>(key, (signal) => api.get(key, signal));

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Reminders</h2>
          <p>Things with a date on them — yours, and the ones you are watching.</p>
        </div>
        <div className="header-controls">
          <label className="checkbox-row">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            Show finished
          </label>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> New reminder
          </button>
        </div>
      </header>

      <AsyncSection query={reminders}>
        {(data) => {
          const active = data.items.filter((r) => r.status === 'active');
          const overdue = active.filter((r) => daysBetween(today(), r.dueOn) < 0);
          const nagging = active.filter((r) => {
            const days = daysBetween(today(), r.dueOn);
            return days >= 0 && r.remindFrom <= today();
          });
          const later = active.filter((r) => r.remindFrom > today());
          const finished = data.items.filter((r) => r.status !== 'active');

          if (data.items.length === 0) {
            return (
              <Empty
                title="Nothing to remember"
                description="Add the things with a date on them — a renewal, a subscription, a job you promised for Friday."
                action={
                  <button type="button" className="primary-button" onClick={() => setCreating(true)}>
                    <Plus size={15} aria-hidden="true" /> New reminder
                  </button>
                }
              />
            );
          }

          return (
            <>
              <Group title="Overdue" tone="overdue" items={overdue} onChanged={reminders.reload} />
              <Group title="Coming up" tone="due" items={nagging} onChanged={reminders.reload} />
              <Group title="Later" tone="quiet" items={later} onChanged={reminders.reload} />
              {showDone ? (
                <Group title="Finished" tone="quiet" items={finished} onChanged={reminders.reload} />
              ) : null}
            </>
          );
        }}
      </AsyncSection>

      {creating ? (
        <ReminderDialog
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reminders.reload(); }}
        />
      ) : null}
    </div>
  );
}

function Group({
  title, tone, items, onChanged,
}: { title: string; tone: string; items: Reminder[]; onChanged: () => void }) {
  // An empty group is noise: the page should say what there is, not what there isn't.
  if (items.length === 0) return null;
  return (
    <section className="panel reminder-group" aria-label={title}>
      <header className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="count-badge">{items.length}</span>
      </header>
      <ul className="reminder-list">
        {items.map((reminder) => (
          <ReminderRow key={reminder.id} reminder={reminder} tone={tone} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function ReminderRow({
  reminder, tone, onChanged,
}: { reminder: Reminder; tone: string; onChanged: () => void }) {
  const { notify } = useNotify();
  const { confirm, element: confirmElement } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const repeats = repeatText(reminder);
  const done = reminder.status !== 'active';

  async function act(run: () => Promise<unknown>, title: string) {
    setBusy(true);
    try {
      await run();
      invalidate('/reminders');
      onChanged();
      notify({ severity: 'success', title });
    } catch (err) {
      notify({ severity: 'warning', title: err instanceof ApiError ? err.message : 'That did not work' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`reminder reminder-${tone} ${done ? 'is-done' : ''}`}>
      <span className={`reminder-kind kind-${reminder.kind}`}>
        {reminder.kind === 'renewal' ? <RefreshCw size={13} aria-hidden="true" />
          : reminder.kind === 'payment' ? <CalendarClock size={13} aria-hidden="true" />
            : <BellRing size={13} aria-hidden="true" />}
        {KIND_WORDS[reminder.kind]}
      </span>

      <div className="reminder-body">
        <strong>{reminder.title}</strong>
        <span className="field-hint">
          {tone === 'overdue' ? <AlertTriangle size={12} aria-hidden="true" /> : null}
          {done ? `was due ${formatDate(reminder.dueOn)}` : `Due ${formatDate(reminder.dueOn)} · ${whenText(reminder.dueOn)}`}
          {repeats ? ` · ${repeats}` : ''}
          {reminder.leadDays > 0 && !done ? ` · reminding from ${formatDate(reminder.remindFrom)}` : ''}
          {reminder.watchers > 0 ? ` · ${reminder.watchers} watching` : ''}
        </span>
        {reminder.notes ? <span className="field-hint">{reminder.notes}</span> : null}
        {reminder.snoozedUntil && reminder.snoozedUntil > today() ? (
          <span className="field-hint">Snoozed until {formatDate(reminder.snoozedUntil)}</span>
        ) : null}
      </div>

      {reminder.amount != null ? (
        <span className="reminder-amount">
          {reminder.currency ?? ''} {reminder.amount.toFixed(2)}
        </span>
      ) : null}

      {!done ? (
        <div className="reminder-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            title={repeats ? 'Done — moves to the next one' : 'Done'}
            onClick={() => void act(
              () => api.post(`/reminders/${reminder.id}/complete`),
              repeats ? 'Done — moved to the next one' : 'Reminder completed',
            )}
          >
            <Check size={14} aria-hidden="true" /> Done
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit ${reminder.title}`}
            title="Edit"
            onClick={() => setEditing(true)}
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            aria-label={`Snooze ${reminder.title} for a week`}
            title="Snooze a week"
            onClick={() => {
              const until = new Date();
              until.setDate(until.getDate() + 7);
              void act(
                () => api.post(`/reminders/${reminder.id}/snooze`, {
                  until: `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`,
                }),
                'Snoozed for a week',
              );
            }}
          >
            <Clock size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            aria-label={`Delete ${reminder.title}`}
            onClick={async () => {
              const yes = await confirm({
                title: `Stop reminding about "${reminder.title}"?`,
                description: repeats
                  ? 'This stops the whole repeating reminder, not just this one.'
                  : 'It will be removed from your list.',
                confirmLabel: 'Stop it',
                destructive: true,
              });
              if (yes) void act(() => api.delete(`/reminders/${reminder.id}`), 'Reminder stopped');
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {editing ? (
        <ReminderDialog
          reminder={reminder}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      ) : null}
      {confirmElement}
    </li>
  );
}

/**
 * Making one.
 *
 * The lead time is a field of its own rather than something clever inferred from the
 * date, because "remind me from" is the half people actually care about and hiding it
 * would make the whole thing a to-do list.
 */
function ReminderDialog({
  reminder, onClose, onSaved,
}: { reminder?: Reminder; onClose: () => void; onSaved: () => void }) {
  const editing = Boolean(reminder);
  const [title, setTitle] = useState(reminder?.title ?? '');
  const [notes, setNotes] = useState(reminder?.notes ?? '');
  const [kind, setKind] = useState<Reminder['kind']>(reminder?.kind ?? 'task');
  const [dueOn, setDueOn] = useState(reminder?.dueOn ?? '');
  const [leadDays, setLeadDays] = useState(reminder?.leadDays ?? 0);
  const [repeatEvery, setRepeatEvery] = useState<Reminder['repeatEvery']>(reminder?.repeatEvery ?? 'none');
  const [repeatInterval, setRepeatInterval] = useState(reminder?.repeatInterval ?? 1);
  const [amount, setAmount] = useState(reminder?.amount != null ? String(reminder.amount) : '');
  const [currency, setCurrency] = useState(reminder?.currency ?? 'LKR');
  const [watcherIds, setWatcherIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const people = useQuery<{ items: { id: string; displayName: string }[] }>(
    '/users?limit=100', (signal) => api.get('/users?limit=100', signal),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!dueOn) { setError('Choose the day it is due.'); return; }
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        notes: notes.trim() || null,
        kind,
        dueOn,
        leadDays,
        repeatEvery,
        repeatInterval,
        amount: amount ? Number(amount) : null,
        currency: amount ? currency : null,
        watcherIds,
      };
      if (reminder) await api.patch(`/reminders/${reminder.id}`, payload);
      else await api.post('/reminders', payload);
      invalidate('/reminders');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={editing ? 'Edit reminder' : 'New reminder'}
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{editing ? 'Edit reminder' : 'New reminder'}</h3>

        <label className="field">
          <span>What is it?</span>
          <input value={title} autoFocus required maxLength={300}
                 placeholder="Renew iinfinityai.com"
                 onChange={(e) => setTitle(e.target.value)} />
        </label>

        <fieldset className="field">
          <legend className="label-row">Kind</legend>
          <div className="portal-kinds">
            {(['task', 'payment', 'renewal', 'other'] as const).map((value) => (
              <label key={value} className={`choice ${kind === value ? 'is-selected' : ''}`}>
                <input type="radio" name="kind" checked={kind === value}
                       onChange={() => setKind(value)} />
                {KIND_WORDS[value]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field-row">
          <label className="field">
            <span>Due on</span>
            <input type="date" value={dueOn} required onChange={(e) => setDueOn(e.target.value)} />
          </label>
          <label className="field">
            <span>Start reminding</span>
            <select value={leadDays} onChange={(e) => setLeadDays(Number(e.target.value))}>
              <option value={0}>On the day</option>
              <option value={1}>1 day before</option>
              <option value={3}>3 days before</option>
              <option value={7}>A week before</option>
              <option value={14}>2 weeks before</option>
              <option value={30}>A month before</option>
              <option value={60}>2 months before</option>
            </select>
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Repeats</span>
            <select value={repeatEvery}
                    onChange={(e) => setRepeatEvery(e.target.value as Reminder['repeatEvery'])}>
              <option value="none">Once only</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
          {repeatEvery !== 'none' ? (
            <label className="field">
              <span>Every</span>
              <input type="number" min={1} max={99} value={repeatInterval}
                     onChange={(e) => setRepeatInterval(Number(e.target.value))} />
            </label>
          ) : null}
        </div>

        {/* Only where it is part of the point — a subscription or a renewal fee. */}
        {kind === 'payment' || kind === 'renewal' ? (
          <div className="field-row">
            <label className="field">
              <span>Amount (optional)</span>
              <input type="number" min={0} step="0.01" value={amount}
                     placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="field">
              <span>Currency</span>
              <input value={currency} maxLength={3}
                     onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </label>
          </div>
        ) : null}

        <label className="field">
          <span>Notes (optional)</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="Account details, who to contact, what needs doing." />
        </label>

        <PeoplePicker
          label="Also remind"
          people={people.data?.items ?? []}
          selected={watcherIds}
          onChange={setWatcherIds}
          emptyHint="Just you. Add anyone else who needs telling."
        />

        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create reminder'}
          </button>
        </div>
      </form>
    </div>
  );
}
