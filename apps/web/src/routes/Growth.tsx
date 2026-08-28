/**
 * Reviews and goals — the personal half of the HR records.
 *
 * Separate from People because the audience is different: this is what you see about
 * yourself and the people you review, whereas People is the directory and the
 * administrative record. Someone opening this is asking "what do I owe, and by when",
 * so outstanding work sits at the top.
 */
import { useState } from 'react';
import { CalendarRange, Target } from 'lucide-react';
import { api } from '../lib/api';
import { useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, FormError } from '../components/States';
import { formatDate, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Review = {
  id: string;
  cycle_id: string;
  cycle_name: string;
  closes_on: string;
  subject_id: string;
  reviewer_id: string;
  subject_name: string;
  reviewer_name: string;
  state: string;
  rating: string | null;
};

type Goal = {
  id: string;
  title: string;
  detail: string | null;
  progress: number;
  status: string;
  due_on: string | null;
};

type Cycle = { id: string; name: string; opens_on: string; closes_on: string; state: string; review_count: number };

export default function Growth() {
  const { can, session } = useSession();
  const [tab, setTab] = useState<'reviews' | 'goals' | 'cycles'>('reviews');
  const tabs = (
    [
      ['reviews', 'Reviews', true],
      ['goals', 'Goals', true],
      ['cycles', 'Cycles', can('review.manage')],
    ] as ['reviews' | 'goals' | 'cycles', string, boolean][]
  ).filter(([, , allowed]) => allowed);

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Growth</h2>
          <p>Your reviews, your goals, and the people you review.</p>
        </div>
      </header>

      <div className="tab-row" role="tablist" aria-label="Growth sections">
        {tabs.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value}
            className={`tab ${tab === value ? 'tab-active' : ''}`} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'reviews' ? <Reviews meId={session?.user?.id ?? ''} /> : null}
      {tab === 'goals' ? <Goals /> : null}
      {tab === 'cycles' ? <Cycles /> : null}
    </div>
  );
}

function Reviews({ meId }: { meId: string }) {
  const [open, setOpen] = useState<Review | null>(null);
  const reviews = useQuery<{ items: Review[] }>('/hr/reviews', (signal) => api.get('/hr/reviews', signal));

  return (
    <>
      <AsyncSection query={reviews}>
        {(data) => {
          const mine = data.items.filter((r) => r.subject_id === meId);
          const toWrite = data.items.filter((r) => r.reviewer_id === meId && r.subject_id !== meId);
          if (data.items.length === 0) {
            return <Empty title="No reviews" description="They appear here when a cycle opens." />;
          }
          return (
            <div className="split-layout">
              <section className="panel" aria-label="Your reviews">
                <h3 className="panel-title">About you</h3>
                {mine.length === 0 ? (
                  <p className="panel-empty">Nothing yet.</p>
                ) : (
                  <ul className="review-list">
                    {mine.map((review) => (
                      <ReviewRow key={review.id} review={review} onOpen={() => setOpen(review)} />
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel" aria-label="Reviews you owe">
                <h3 className="panel-title">Yours to write</h3>
                {toWrite.length === 0 ? (
                  <p className="panel-empty">Nothing outstanding.</p>
                ) : (
                  <ul className="review-list">
                    {toWrite.map((review) => (
                      <ReviewRow key={review.id} review={review} showSubject onOpen={() => setOpen(review)} />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          );
        }}
      </AsyncSection>

      {open ? <ReviewDialog review={open} meId={meId} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function ReviewRow({ review, showSubject, onOpen }: { review: Review; showSubject?: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="review-button" onClick={onOpen}>
        <div>
          <strong>{showSubject ? review.subject_name : review.cycle_name}</strong>
          <span>
            {showSubject ? `${review.cycle_name} · ` : ''}closes {formatDate(review.closes_on)}
          </span>
        </div>
        <span className={`status-tag status-${review.state === 'shared' ? 'active' : 'pending'}`}>
          {titleCase(review.state.replace('_', ' '))}
        </span>
      </button>
    </li>
  );
}

function ReviewDialog({ review, meId, onClose }: { review: Review; meId: string; onClose: () => void }) {
  const detail = useQuery<Record<string, string | boolean | null>>(
    `/hr/reviews/${review.id}`,
    (signal) => api.get(`/hr/reviews/${review.id}`, signal),
  );
  const [self, setSelf] = useState<string | null>(null);
  const [manager, setManager] = useState<string | null>(null);
  const [rating, setRating] = useState('');

  const isSubject = review.subject_id === meId;
  const isReviewer = review.reviewer_id === meId && !isSubject;

  const saveSelf = useMutation(
    async () => api.put(`/hr/reviews/${review.id}/self`, { text: self ?? '' }),
    { invalidates: ['/hr/reviews'] },
  );
  const saveManager = useMutation(
    async (share: boolean) =>
      api.put(`/hr/reviews/${review.id}/manager`, { text: manager ?? '', rating: rating || null, share }),
    { invalidates: ['/hr/reviews'], onSuccess: onClose },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="review-title" onClick={(e) => e.stopPropagation()}>
        <AsyncSection query={detail}>
          {(data) => (
            <>
              <h3 id="review-title">
                {review.cycle_name} — {isSubject ? 'your review' : String(data.subject_name)}
              </h3>

              <FormError error={saveSelf.error} />
              <FormError error={saveManager.error} />

              <div className="field">
                <label htmlFor="self-assessment">Self-assessment</label>
                <textarea id="self-assessment" rows={6}
                  value={self ?? String(data.self_assessment ?? '')}
                  disabled={!isSubject}
                  onChange={(e) => setSelf(e.target.value)}
                  placeholder={isSubject ? 'What went well, what was hard, what you want next.' : ''} />
                {isSubject ? (
                  <button type="button" className="ghost-button" disabled={saveSelf.pending}
                    onClick={() => void saveSelf.mutate()}>
                    {saveSelf.pending ? 'Saving…' : 'Save self-assessment'}
                  </button>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="manager-assessment">Reviewer's assessment</label>
                {data.manager_withheld ? (
                  <p className="field-hint">
                    {String(data.reviewer_name)} has not shared this yet. You will see it when
                    they do.
                  </p>
                ) : (
                  <textarea id="manager-assessment" rows={6}
                    value={manager ?? String(data.manager_assessment ?? '')}
                    disabled={!isReviewer}
                    onChange={(e) => setManager(e.target.value)}
                    placeholder={isReviewer ? 'What you have seen, and what comes next.' : ''} />
                )}
              </div>

              {isReviewer ? (
                <>
                  <div className="field">
                    <label htmlFor="review-rating">Overall</label>
                    <select id="review-rating" value={rating || String(data.rating ?? '')} onChange={(e) => setRating(e.target.value)}>
                      <option value="">No rating</option>
                      {['below', 'meets', 'exceeds', 'outstanding'].map((r) => (
                        <option key={r} value={r}>{titleCase(r)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="dialog-actions">
                    <button type="button" className="ghost-button" onClick={onClose}>Close</button>
                    <button type="button" className="ghost-button" disabled={saveManager.pending}
                      onClick={() => void saveManager.mutate(false)}>
                      Save without sharing
                    </button>
                    <button type="button" className="primary-button" disabled={saveManager.pending}
                      onClick={() => void saveManager.mutate(true)}>
                      {saveManager.pending ? 'Sharing…' : 'Save and share'}
                    </button>
                  </div>
                  <p className="field-hint">
                    Saving without sharing keeps it private to you until you are ready.
                  </p>
                </>
              ) : (
                <div className="dialog-actions">
                  <button type="button" className="primary-button" onClick={onClose}>Close</button>
                </div>
              )}
            </>
          )}
        </AsyncSection>
      </div>
    </div>
  );
}

function Goals() {
  const [title, setTitle] = useState('');
  const goals = useQuery<{ items: Goal[] }>('/hr/goals', (signal) => api.get('/hr/goals', signal));

  const create = useMutation(async () => api.post('/hr/goals', { title }), {
    invalidates: ['/hr/goals'],
    onSuccess: () => setTitle(''),
  });
  const update = useMutation(
    async (input: { id: string; progress?: number; status?: string }) =>
      api.patch(`/hr/goals/${input.id}`, { progress: input.progress, status: input.status }),
    { invalidates: ['/hr/goals'] },
  );

  return (
    <section className="panel" aria-label="Goals">
      <FormError error={create.error} />
      <form className="goal-form" onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
        <div className="field">
          <label htmlFor="goal-title">New goal</label>
          <input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Cut deploy time below ten minutes" required />
        </div>
        <button type="submit" className="primary-button" disabled={create.pending || !title.trim()}>
          <Target size={15} aria-hidden="true" /> Add
        </button>
      </form>

      <AsyncSection query={goals}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty title="No goals" description="What are you working towards this cycle?" />
          ) : (
            <ul className="goal-list">
              {data.items.map((goal) => (
                <li key={goal.id} className={goal.status === 'achieved' ? 'goal-done' : ''}>
                  <div className="goal-head">
                    <strong>{goal.title}</strong>
                    <label className="visually-hidden" htmlFor={`goal-status-${goal.id}`}>
                      Status of {goal.title}
                    </label>
                    <select id={`goal-status-${goal.id}`} className="inline-select" value={goal.status}
                      onChange={(e) => void update.mutate({ id: goal.id, status: e.target.value })}>
                      {['active', 'at_risk', 'achieved', 'dropped'].map((s) => (
                        <option key={s} value={s}>{titleCase(s.replace('_', ' '))}</option>
                      ))}
                    </select>
                  </div>
                  {/* Progress and status are separate controls because "eighty percent
                      done but at risk" is the state that actually matters. */}
                  <div className="goal-progress">
                    <label className="visually-hidden" htmlFor={`goal-progress-${goal.id}`}>
                      Progress on {goal.title}
                    </label>
                    <input id={`goal-progress-${goal.id}`} type="range" min={0} max={100} step={5}
                      defaultValue={goal.progress}
                      onChange={(e) => void update.mutate({ id: goal.id, progress: Number(e.target.value) })} />
                    <span className={`goal-percent ${goal.status === 'at_risk' ? 'goal-percent-risk' : ''}`}>
                      {goal.progress}%
                    </span>
                  </div>
                  {goal.due_on ? <span className="task-meta">Due {formatDate(goal.due_on)}</span> : null}
                </li>
              ))}
            </ul>
          )
        }
      </AsyncSection>
    </section>
  );
}

function Cycles() {
  const [name, setName] = useState('');
  const [opensOn, setOpensOn] = useState('');
  const [closesOn, setClosesOn] = useState('');
  const cycles = useQuery<{ items: Cycle[] }>('/hr/cycles', (signal) => api.get('/hr/cycles', signal));

  const open = useMutation(async () => api.post('/hr/cycles', { name, opensOn, closesOn }), {
    invalidates: ['/hr/cycles', '/hr/reviews'],
    onSuccess: () => { setName(''); setOpensOn(''); setClosesOn(''); },
  });

  return (
    <div className="operations-grid">
      <section className="panel" aria-labelledby="cycle-new">
        <h3 id="cycle-new">Open a cycle</h3>
        <p className="field-hint">
          A review is created for everyone who has a manager, so the reporting line needs
          to be right before you open one — anybody without a manager gets no review.
        </p>
        <FormError error={open.error} />
        <form onSubmit={(e) => { e.preventDefault(); void open.mutate(); }}>
          <div className="field">
            <label htmlFor="cycle-name">Name</label>
            <input id="cycle-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="H2 2026" required />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="cycle-opens">Opens</label>
              <input id="cycle-opens" type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="cycle-closes">Closes</label>
              <input id="cycle-closes" type="date" value={closesOn} min={opensOn || undefined} onChange={(e) => setClosesOn(e.target.value)} required />
            </div>
          </div>
          <button type="submit" className="primary-button" disabled={open.pending}>
            <CalendarRange size={15} aria-hidden="true" /> Open cycle
          </button>
        </form>
      </section>

      <section className="panel" aria-labelledby="cycle-list">
        <h3 id="cycle-list">Cycles</h3>
        <AsyncSection query={cycles}>
          {(data) =>
            data.items.length === 0 ? (
              <p className="panel-empty">No cycles yet.</p>
            ) : (
              <ul className="cycle-list">
                {data.items.map((cycle) => (
                  <li key={cycle.id}>
                    <div>
                      <strong>{cycle.name}</strong>
                      <span>
                        {formatDate(cycle.opens_on)} – {formatDate(cycle.closes_on)} ·{' '}
                        {cycle.review_count} review{Number(cycle.review_count) === 1 ? '' : 's'}
                      </span>
                    </div>
                    <span className={`status-tag status-${cycle.state === 'open' ? 'active' : ''}`}>
                      {titleCase(cycle.state)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncSection>
      </section>
    </div>
  );
}
