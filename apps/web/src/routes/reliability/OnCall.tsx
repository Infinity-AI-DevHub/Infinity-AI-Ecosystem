/**
 * On-call: who is on call now and next, cover for a shift, and the escalation policies
 * that decide who is paged when.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/reliability.css';

type Schedule = {
  id: string; name: string; timezone: string; rotation: 'daily' | 'weekly'; handoffMinute: number; rotationStart: string;
  members: { id: string; name: string }[];
  current: { userId: string; name: string; until: string; override: boolean } | null;
  upcoming: { userId: string; name: string; startsAt: string; endsAt: string; override: boolean }[];
  overrides: { id: string; userId: string; name: string; startsAt: string; endsAt: string; reason: string | null }[];
};
type Policy = { id: string; name: string; repeatCount: number; levels: { delayMinutes: number; targets: { type: 'schedule' | 'user'; id: string; name: string }[] }[] };
type Person = { id: string; displayName: string };

const pad = (n: number) => String(n).padStart(2, '0');
const toLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default function OnCall() {
  const { can, session } = useSession();
  const schedules = useQuery<{ items: Schedule[] }>('/reliability/schedules', (s) => api.get('/reliability/schedules', s));
  const policies = useQuery<{ items: Policy[] }>('/reliability/escalation-policies', (s) => api.get('/reliability/escalation-policies', s));
  const people = useQuery<Paged<Person>>(can('user.read') ? '/users?limit=100' : null, (s) => api.get('/users?limit=100', s));
  const [editingSchedule, setEditingSchedule] = useState<Schedule | 'new' | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<Policy | 'new' | null>(null);
  const [covering, setCovering] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = can('reliability.manage');

  if (schedules.loading && !schedules.data) return <Loading label="Loading on-call" rows={5} />;
  if (schedules.error && !schedules.data) return <ErrorState error={schedules.error} onRetry={schedules.reload} />;

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Reliability</p><h2>On-call</h2></div>
        <div className="cc-header-side">{manage ? <button type="button" className="primary-button" onClick={() => setEditingSchedule('new')}><Plus size={15} aria-hidden="true" /> New schedule</button> : null}</div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      {schedules.data!.items.length === 0 ? <Empty title="No on-call schedules" description={manage ? 'Create a rotation of the people who respond out of hours.' : 'A reliability manager has not set up on-call yet.'} /> : (
        <div className="cc-grid">
          {schedules.data!.items.map((s) => {
            const member = s.members.some((m) => m.id === session?.user?.id);
            return (
              <section key={s.id} className="cc-panel" aria-label={s.name}>
                <header><h3>{s.name}</h3><span className="cc-meta">{s.rotation} · {pad(Math.floor(s.handoffMinute / 60))}:{pad(s.handoffMinute % 60)} {s.timezone}</span></header>
                <div className="rl-oncall-now">
                  <span className="cc-dot is-ok" aria-hidden="true" />
                  <div><strong>{s.current?.name ?? 'Nobody'}</strong><div className="field-hint">{s.current ? `on call until ${formatDateTime(s.current.until)}${s.current.override ? ' (covering)' : ''}` : 'The rotation has not started'}</div></div>
                </div>
                <ul className="rl-shifts" aria-label="Upcoming shifts">
                  {s.upcoming.slice(1).map((u, n) => <li key={n}><span>{u.name}{u.override ? ' (covering)' : ''}</span><span className="cc-meta">{formatDateTime(u.startsAt)}</span></li>)}
                </ul>
                {s.overrides.length > 0 ? (
                  <>
                    <h4 className="sd-subhead sd-panel-pad">Cover</h4>
                    <ul className="cc-rows">{s.overrides.map((o) => (
                      <li key={o.id} className="sd-link-row">
                        <span className="cc-row"><span className="cc-row-main"><strong>{o.name}</strong><span>{formatDateTime(o.startsAt)} – {formatDateTime(o.endsAt)}{o.reason ? ` · ${o.reason}` : ''}</span></span></span>
                        {manage || o.userId === session?.user?.id ? <button type="button" className="icon-button" aria-label={`Remove cover by ${o.name}`} onClick={async () => { setError(null); try { await api.delete(`/reliability/overrides/${o.id}`); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not removed.'); } invalidate('/reliability/schedules'); }}><Trash2 size={14} /></button> : null}
                      </li>
                    ))}</ul>
                  </>
                ) : null}
                <div className="sd-panel-pad sd-inline">
                  {manage || member ? <button type="button" className="ghost-button" onClick={() => setCovering(s)}>{manage ? 'Add cover' : 'Cover a shift'}</button> : null}
                  {manage ? <button type="button" className="sd-link-button" onClick={() => setEditingSchedule(s)}>Edit rotation</button> : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <section className="cc-panel" aria-label="Escalation policies">
        <header><h3>Escalation policies</h3>{manage ? <button type="button" className="sd-link-button" onClick={() => setEditingPolicy('new')}>New policy</button> : null}</header>
        {!policies.data ? <Loading rows={2} /> : policies.data.items.length === 0 ? <p className="cc-empty">No policies. A service with no policy pages nobody.</p> : (
          <div className="sd-panel-pad cc-grid">
            {policies.data.items.map((p) => (
              <div key={p.id} className="rl-level-card">
                <div className="sd-inline"><strong>{p.name}</strong>{manage ? <button type="button" className="sd-link-button" onClick={() => setEditingPolicy(p)}>Edit</button> : null}</div>
                <ol className="rl-levels">
                  {p.levels.map((l, n) => (
                    <li key={n} className="rl-level">
                      <header>Level {n + 1}<span className="cc-meta">{n === 0 ? 'immediately' : `after ${l.delayMinutes} min without acknowledgement`}</span></header>
                      <span className="field-hint">{l.targets.map((t) => `${t.name}${t.type === 'schedule' ? ' (on call)' : ''}`).join(', ')}</span>
                    </li>
                  ))}
                </ol>
                <span className="field-hint">{p.repeatCount ? `Repeats ${p.repeatCount} ${p.repeatCount === 1 ? 'time' : 'times'}, then incident managers are told.` : 'Does not repeat; incident managers are told if nobody acknowledges.'}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {editingSchedule ? <ScheduleDialog schedule={editingSchedule === 'new' ? null : editingSchedule} people={people.data?.items ?? []} onClose={() => { setEditingSchedule(null); invalidate('/reliability/schedules'); }} /> : null}
      {editingPolicy ? <PolicyDialog policy={editingPolicy === 'new' ? null : editingPolicy} schedules={schedules.data!.items} people={people.data?.items ?? []} onClose={() => { setEditingPolicy(null); invalidate('/reliability/escalation-policies'); }} /> : null}
      {covering ? <CoverDialog schedule={covering} manage={manage} people={people.data?.items ?? []} selfId={session?.user?.id ?? ''} onClose={() => { setCovering(null); invalidate('/reliability/schedules'); }} /> : null}
    </div>
  );
}

function ScheduleDialog({ schedule, people, onClose }: { schedule: Schedule | null; people: Person[]; onClose: () => void }) {
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];
  const [f, setF] = useState({
    name: schedule?.name ?? '', timezone: schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, rotation: schedule?.rotation ?? 'weekly',
    handoff: schedule ? `${pad(Math.floor(schedule.handoffMinute / 60))}:${pad(schedule.handoffMinute % 60)}` : '09:00',
    rotationStart: schedule?.rotationStart ?? new Date().toISOString().slice(0, 10), members: schedule?.members.map((m) => m.id) ?? [],
  });
  const [add, setAdd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => people.find((p) => p.id === id)?.displayName ?? schedule?.members.find((m) => m.id === id)?.name ?? 'Unknown';
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="sched-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const [h, m] = f.handoff.split(':').map(Number);
          const body = { name: f.name, timezone: f.timezone, rotation: f.rotation, handoffMinute: (h ?? 0) * 60 + (m ?? 0), rotationStart: f.rotationStart, members: f.members };
          try { if (schedule) await api.put(`/reliability/schedules/${schedule.id}`, body); else await api.post('/reliability/schedules', body); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'The schedule was not saved.'); }
        }}>
        <h3 id="sched-title">{schedule ? 'Edit rotation' : 'New on-call schedule'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Name</span><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={120} placeholder="Platform primary" /></label>
          <label className="field"><span>Rotation</span><select value={f.rotation} onChange={(e) => setF({ ...f, rotation: e.target.value as 'daily' | 'weekly' })}><option value="weekly">Weekly</option><option value="daily">Daily</option></select></label>
          <label className="field"><span>Handoff time</span><input type="time" value={f.handoff} onChange={(e) => setF({ ...f, handoff: e.target.value })} required /></label>
          <label className="field"><span>First shift starts</span><input type="date" value={f.rotationStart} onChange={(e) => setF({ ...f, rotationStart: e.target.value })} required /></label>
          <label className="field"><span>Timezone</span><select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select></label>
          <div className="field sd-span-2">
            <span>Rotation order</span>
            <ol className="rl-levels">
              {f.members.map((id, n) => (
                <li key={id} className="rl-level sd-inline">
                  <span>{n + 1}. {name(id)}</span>
                  <span className="sd-inline">
                    <button type="button" className="sd-link-button" disabled={n === 0} onClick={() => { const next = [...f.members]; [next[n - 1], next[n]] = [next[n]!, next[n - 1]!]; setF({ ...f, members: next }); }}>Up</button>
                    <button type="button" className="sd-link-button" onClick={() => setF({ ...f, members: f.members.filter((x) => x !== id) })}>Remove</button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="sd-inline">
              <select aria-label="Add to rotation" value={add} onChange={(e) => setAdd(e.target.value)}><option value="">Add a person…</option>{people.filter((p) => !f.members.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select>
              <button type="button" className="ghost-button" disabled={!add} onClick={() => { setF({ ...f, members: [...f.members, add] }); setAdd(''); }}>Add</button>
            </div>
          </div>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {schedule ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete the ${schedule.name} schedule and its cover?`)) return;
            try { await api.delete(`/reliability/schedules/${schedule.id}`); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={f.members.length === 0}>Save</button>
        </div>
      </form>
    </div>
  );
}

function PolicyDialog({ policy, schedules, people, onClose }: { policy: Policy | null; schedules: Schedule[]; people: Person[]; onClose: () => void }) {
  const [name, setName] = useState(policy?.name ?? '');
  const [repeat, setRepeat] = useState(policy?.repeatCount ?? 1);
  const [levels, setLevels] = useState(policy?.levels.map((l) => ({ delayMinutes: l.delayMinutes, targets: l.targets.map((t) => `${t.type}:${t.id}`) })) ?? [{ delayMinutes: 0, targets: [] as string[] }]);
  const [error, setError] = useState<string | null>(null);
  const options = [...schedules.map((s) => ({ value: `schedule:${s.id}`, label: `${s.name} (whoever is on call)` })), ...people.map((p) => ({ value: `user:${p.id}`, label: p.displayName }))];
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="policy-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { name, repeatCount: repeat, levels: levels.map((l) => ({ delayMinutes: l.delayMinutes, targets: l.targets.map((t) => { const [type, id] = t.split(':'); return { type, id }; }) })) };
          try { if (policy) await api.put(`/reliability/escalation-policies/${policy.id}`, body); else await api.post('/reliability/escalation-policies', body); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'The policy was not saved.'); }
        }}>
        <h3 id="policy-title">{policy ? 'Edit escalation policy' : 'New escalation policy'}</h3>
        <div className="sd-form-grid">
          <label className="field"><span>Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} placeholder="Payments" /></label>
          <label className="field"><span>Repeat if nobody acknowledges</span><select value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? 'Do not repeat' : `${n} ${n === 1 ? 'time' : 'times'}`}</option>)}</select></label>
        </div>
        <ol className="rl-levels">
          {levels.map((l, n) => (
            <li key={n} className="rl-level">
              <header>Level {n + 1}
                {n > 0 ? <label className="sd-inline"><span className="cc-meta">after</span><input type="number" min={1} max={1440} value={l.delayMinutes} aria-label={`Level ${n + 1} delay minutes`} onChange={(e) => setLevels(levels.map((x, i) => (i === n ? { ...x, delayMinutes: Number(e.target.value) } : x)))} /><span className="cc-meta">min</span></label> : <span className="cc-meta">pages immediately</span>}
                {levels.length > 1 ? <button type="button" className="sd-link-button" onClick={() => setLevels(levels.filter((_, i) => i !== n))}>Remove level</button> : null}
              </header>
              <select multiple aria-label={`Level ${n + 1} targets`} value={l.targets} size={Math.min(6, options.length)} onChange={(e) => setLevels(levels.map((x, i) => (i === n ? { ...x, targets: [...e.target.selectedOptions].map((o) => o.value) } : x)))}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </li>
          ))}
        </ol>
        <button type="button" className="ghost-button" disabled={levels.length >= 6} onClick={() => setLevels([...levels, { delayMinutes: 15, targets: [] }])}><Plus size={14} aria-hidden="true" /> Add level</button>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {policy ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete the ${policy.name} escalation policy?`)) return;
            try { await api.delete(`/reliability/escalation-policies/${policy.id}`); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={levels.some((l) => l.targets.length === 0)}>Save</button>
        </div>
      </form>
    </div>
  );
}

function CoverDialog({ schedule, manage, people, selfId, onClose }: { schedule: Schedule; manage: boolean; people: Person[]; selfId: string; onClose: () => void }) {
  const now = new Date();
  const [f, setF] = useState({ userId: selfId, startsAt: toLocal(new Date(now.getTime() + 3600000)), endsAt: toLocal(new Date(now.getTime() + 13 * 3600000)), reason: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="cover-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { await api.post(`/reliability/schedules/${schedule.id}/overrides`, { userId: f.userId, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), reason: f.reason || null }); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'The cover was not added.'); }
        }}>
        <h3 id="cover-title">Cover on {schedule.name}</h3>
        <div className="sd-form-grid">
          {manage ? <label className="field sd-span-2"><span>Who covers</span><select autoFocus value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label> : <p className="field-hint sd-span-2">You will be on call instead of the rotation for this period.</p>}
          <label className="field"><span>From</span><input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} required /></label>
          <label className="field"><span>Until</span><input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} required /></label>
          <label className="field sd-span-2"><span>Reason</span><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={300} placeholder="Swap with Ana for Friday" /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save cover</button></div>
      </form>
    </div>
  );
}
