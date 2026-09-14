/**
 * One course. Learners start it, read each lesson, take the quiz and earn the
 * certification. Academy managers also edit lessons and questions, publish, assign it and
 * see who has done it.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Plus } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { formatDate } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { CourseDialog, LEVELS } from './Learning';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/academy.css';

type Lesson = { id: string; position: number; title: string; body: string; videoUrl: string | null; minutes: number; done: boolean };
type Question = { id: string; prompt: string; options: string[]; correctIndex?: number };
type CourseDetail = {
  id: string; title: string; summary: string | null; category: string | null; status: 'draft' | 'published' | 'archived'; passMark: number | null;
  certificationName: string | null; validityMonths: number | null; lessons: Lesson[]; questions: Question[]; skills: { id: string; name: string; level: number }[];
  enrolment: { status: string; source: string; dueAt: string | null; score: number | null; attempts: number; completedAt: string | null } | null;
  lastAttempt: { score: number; passed: boolean; at: string } | null;
  certification: { issuedAt: string; expiresAt: string | null; expired: boolean } | null;
  permissions: { canManage: boolean };
};

export default function CoursePage() {
  const { courseId } = useParams();
  const key = `/academy/courses/${courseId}`;
  const course = useQuery<CourseDetail>(courseId ? key : null, (s) => api.get(key, s));
  const [view, setView] = useState<'learn' | 'build' | 'people'>('learn');
  // Held here, not in the player: saving progress reloads the course, which remounts the
  // player, and the learner must stay where they were and still see their quiz result.
  const [position, setPosition] = useState<string | null>(null);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (course.loading && !course.data) return <Loading label="Loading course" rows={5} />;
  if (course.error && !course.data) {
    return (course.error as { status?: number }).status === 404
      ? <Empty title="Course not found" action={<Link className="ghost-button" to="/academy">Academy</Link>} />
      : <ErrorState error={course.error} onRetry={course.reload} />;
  }
  const c = course.data!;
  const refresh = () => invalidate('/academy/');
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); } refresh(); };

  return (
    <div className="module-page cc-page sd-detail-page">
      <Link to="/academy" className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> Academy</Link>
      <header className="sd-detail-head">
        <div>
          <p className="cc-eyebrow">{c.category ?? 'Course'}{c.status !== 'published' ? ` · ${c.status}` : ''}</p>
          <h2>{c.title}</h2>
          <div className="rl-head-meta">
            {c.summary ? <span>{c.summary}</span> : null}
            {c.certificationName ? <span className="cc-tag cc-tag-info">Certifies: {c.certificationName}{c.validityMonths ? ` · ${c.validityMonths} months` : ''}</span> : null}
            {c.skills.map((s) => <span key={s.id} className="cc-tag">{s.name} · {LEVELS[s.level]}</span>)}
          </div>
        </div>
        {c.permissions.canManage ? (
          <div className="cc-header-side">
            {c.status !== 'published' ? <button type="button" className="primary-button" onClick={() => void act(() => api.post(`/academy/courses/${c.id}/status`, { status: 'published' }))}>Publish</button>
              : <button type="button" className="ghost-button" onClick={() => { if (window.confirm('Archive this course? People can no longer start it.')) void act(() => api.post(`/academy/courses/${c.id}/status`, { status: 'archived' })); }}>Archive</button>}
            <button type="button" className="ghost-button" onClick={() => { if (window.confirm(`Delete "${c.title}"? Only a course nobody has started can be deleted.`)) void act(async () => { await api.delete(`/academy/courses/${c.id}`); navigate('/academy'); }); }}>Delete</button>
          </div>
        ) : null}
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {c.permissions.canManage ? (
        <div className="tab-row" role="tablist" aria-label="Course views">
          {([['learn', 'Take the course'], ['build', 'Lessons and quiz'], ['people', 'Assign and track']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} className={`tab ${view === id ? 'tab-active' : ''}`} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      ) : null}
      {view === 'learn' ? <Player course={c} onError={setError} onChanged={refresh} position={position} setPosition={setPosition} result={result} setResult={setResult} /> : view === 'build' ? <Builder course={c} onChanged={refresh} /> : <People course={c} />}
    </div>
  );
}

type QuizResult = { score: number; passed: boolean; passMark: number };

function Player({ course: c, onError, onChanged, position, setPosition, result, setResult }: {
  course: CourseDetail; onError: (m: string | null) => void; onChanged: () => void;
  position: string | null; setPosition: (p: string | null) => void; result: QuizResult | null; setResult: (r: QuizResult | null) => void;
}) {
  const firstOpen = c.lessons.find((l) => !l.done)?.id ?? c.lessons[0]?.id ?? null;
  const current = position ?? firstOpen;
  const setCurrent = setPosition;
  const [answers, setAnswers] = useState<(number | null)[]>(c.questions.map(() => null));
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { onError(null); setBusy(true); try { await fn(); } catch (err) { onError(err instanceof ApiError ? err.message : 'That did not work.'); } finally { setBusy(false); onChanged(); } };

  if (c.lessons.length === 0) return <Empty title="No lessons yet" description="This course has no content to take." />;
  if (!c.enrolment) {
    return (
      <section className="cc-panel" aria-label="Start">
        <p className="sd-panel-pad">{c.lessons.length} {c.lessons.length === 1 ? 'lesson' : 'lessons'}, about {c.lessons.reduce((a, l) => a + l.minutes, 0)} minutes{c.passMark !== null ? `, then a quiz (pass mark ${c.passMark}%)` : ''}.</p>
        <div className="sd-panel-pad">{c.status === 'published' ? <button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => api.post(`/academy/courses/${c.id}/enrol`, {}))}>Start course</button> : <span className="field-hint">Publish the course before anyone can take it.</span>}</div>
      </section>
    );
  }
  const lesson = c.lessons.find((l) => l.id === current);
  const done = c.lessons.filter((l) => l.done).length;
  const nearExpiry = c.certification?.expiresAt && new Date(c.certification.expiresAt).getTime() - Date.now() < 60 * 86_400_000;

  return (
    <div className="ac-player">
      <section className="cc-panel" aria-label="Contents">
        <header><h3>Contents</h3><span className="cc-meta">{done}/{c.lessons.length}</span></header>
        <div className="sd-panel-pad"><div className="ac-progress" aria-hidden="true"><span style={{ width: `${(done / c.lessons.length) * 100}%` }} /></div></div>
        <ul className="ac-lessons">
          {c.lessons.map((l) => (
            <li key={l.id}><button type="button" aria-current={current === l.id} onClick={() => setCurrent(l.id)}>
              {l.done ? <CheckCircle2 size={14} className="ac-tick" aria-label="Done" /> : <span className="ac-dot" aria-hidden="true" />}{l.title}
            </button></li>
          ))}
          {c.passMark !== null ? <li><button type="button" aria-current={current === 'quiz'} onClick={() => setCurrent('quiz')}>
            {c.lastAttempt?.passed ? <CheckCircle2 size={14} className="ac-tick" aria-label="Passed" /> : <span className="ac-dot" aria-hidden="true" />}Quiz
          </button></li> : null}
        </ul>
        {c.enrolment.status === 'completed' ? (
          <div className="sd-panel-pad">
            <p className="ac-done"><CheckCircle2 size={14} aria-hidden="true" /> Completed {c.enrolment.completedAt ? formatDate(c.enrolment.completedAt) : ''}</p>
            {c.certification ? <p className="field-hint">{c.certification.expired ? 'Certification expired' : 'Certified'}{c.certification.expiresAt ? ` · ${c.certification.expired ? '' : 'until '}${formatDate(c.certification.expiresAt)}` : ''}</p> : null}
            {nearExpiry ? <button type="button" className="ghost-button" disabled={busy} onClick={() => void run(() => api.post(`/academy/courses/${c.id}/restart`, {}))}>Retake to renew</button> : null}
          </div>
        ) : c.enrolment.dueAt ? <p className="sd-panel-pad field-hint">Due {formatDate(c.enrolment.dueAt)}</p> : null}
      </section>

      {current === 'quiz' ? (
        <section className="cc-panel" aria-label="Quiz">
          <header><h3>Quiz</h3><span className="cc-meta">Pass mark {c.passMark}%{c.enrolment.attempts ? ` · ${c.enrolment.attempts} ${c.enrolment.attempts === 1 ? 'attempt' : 'attempts'}` : ''}</span></header>
          {result ? <p className={`ac-result ${result.passed ? 'is-pass' : 'is-fail'}`} role="status">{result.score}% · {result.passed ? 'Passed' : `Not passed. You need ${result.passMark}%.`}</p>
            : c.lastAttempt ? <p className={`ac-result ${c.lastAttempt.passed ? 'is-pass' : 'is-fail'}`}>Last attempt {c.lastAttempt.score}% · {c.lastAttempt.passed ? 'passed' : 'not passed'}</p> : null}
          {c.enrolment.status === 'completed' ? <p className="sd-panel-pad">You have completed this course.</p> : (
            <form className="ac-quiz" onSubmit={(e) => { e.preventDefault(); void run(async () => setResult(await api.post(`/academy/courses/${c.id}/quiz`, { answers }))); }}>
              {c.questions.map((q, qi) => (
                <fieldset key={q.id}>
                  <legend>{qi + 1}. {q.prompt}</legend>
                  {q.options.map((o, oi) => (
                    <label key={oi}><input type="radio" name={`q-${q.id}`} checked={answers[qi] === oi} onChange={() => setAnswers(answers.map((a, i) => (i === qi ? oi : a)))} /> {o}</label>
                  ))}
                </fieldset>
              ))}
              <div><button type="submit" className="primary-button" disabled={busy || answers.some((a) => a === null)}>Submit answers</button></div>
              {done < c.lessons.length ? <p className="field-hint">You can take the quiz now; the course completes once every lesson is also marked done.</p> : null}
            </form>
          )}
        </section>
      ) : lesson ? (
        <section className="cc-panel" aria-label={lesson.title}>
          <header><h3>{lesson.title}</h3><span className="cc-meta">{lesson.minutes} min</span></header>
          {lesson.videoUrl ? <p className="sd-panel-pad"><a href={lesson.videoUrl} target="_blank" rel="noreferrer noopener">Watch the video</a></p> : null}
          <div className="ac-lesson-body">{lesson.body}</div>
          <div className="ac-lesson-foot">
            {lesson.done ? <span className="ac-done"><CheckCircle2 size={14} aria-hidden="true" /> Done</span>
              : <button type="button" className="primary-button" disabled={busy} onClick={() => void run(async () => {
                await api.post(`/academy/courses/${c.id}/lessons/${lesson.id}/complete`, {});
                const next = c.lessons[c.lessons.indexOf(lesson) + 1];
                setCurrent(next ? next.id : c.passMark !== null ? 'quiz' : lesson.id);
              })}>Mark as done</button>}
            {(() => { const next = c.lessons[c.lessons.indexOf(lesson) + 1]; return next ? <button type="button" className="sd-link-button" onClick={() => setCurrent(next.id)}>Next: {next.title}</button> : c.passMark !== null ? <button type="button" className="sd-link-button" onClick={() => setCurrent('quiz')}>Go to the quiz</button> : null; })()}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Builder({ course: c, onChanged }: { course: CourseDetail; onChanged: () => void }) {
  const [editingCourse, setEditingCourse] = useState(false);
  const [lesson, setLesson] = useState<Lesson | 'new' | null>(null);
  const [questions, setQuestions] = useState<Question[]>(c.questions);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <div className="sd-detail-grid">
      <div className="sd-main">
        <section className="cc-panel" aria-label="Lessons">
          <header><h3>Lessons</h3><button type="button" className="sd-link-button" onClick={() => setLesson('new')}><Plus size={13} aria-hidden="true" /> Add lesson</button></header>
          {c.lessons.length === 0 ? <p className="cc-empty">No lessons yet.</p> : (
            <ul className="cc-rows">{c.lessons.map((l, i) => (
              <li key={l.id} className="cc-row">
                <span className="cc-row-main"><strong>{i + 1}. {l.title}</strong><span>{l.minutes} min · {l.body.slice(0, 90)}{l.body.length > 90 ? '…' : ''}</span></span>
                <button type="button" className="sd-link-button" onClick={() => setLesson(l)}>Edit</button>
                <button type="button" className="sd-link-button" onClick={async () => { if (!window.confirm(`Delete "${l.title}"? Progress on it is lost.`)) return; try { await api.delete(`/academy/courses/${c.id}/lessons/${l.id}`); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); } onChanged(); }}>Delete</button>
              </li>
            ))}</ul>
          )}
        </section>
        <section className="cc-panel" aria-label="Quiz questions">
          <header><h3>Quiz</h3>{c.passMark === null ? <span className="cc-meta">No quiz: set a pass mark in the course settings to add one</span> : <span className="cc-meta">Pass mark {c.passMark}%</span>}</header>
          {c.passMark !== null ? (
            <form className="ac-quiz" onSubmit={async (e) => {
              e.preventDefault(); setError(null); setSaved(false);
              try { await api.put(`/academy/courses/${c.id}/questions`, { questions: questions.map((q) => ({ prompt: q.prompt, options: q.options, correctIndex: q.correctIndex ?? 0 })) }); setSaved(true); }
              catch (err) { setError(err instanceof ApiError ? err.message : 'Questions were not saved.'); }
              onChanged();
            }}>
              {questions.map((q, qi) => (
                <fieldset key={qi}>
                  <legend className="sd-inline">
                    <input aria-label={`Question ${qi + 1}`} required minLength={3} maxLength={500} value={q.prompt} placeholder={`Question ${qi + 1}`} onChange={(e) => setQuestions(questions.map((x, i) => (i === qi ? { ...x, prompt: e.target.value } : x)))} />
                    <button type="button" className="sd-link-button" onClick={() => setQuestions(questions.filter((_, i) => i !== qi))}>Remove</button>
                  </legend>
                  {q.options.map((o, oi) => (
                    <label key={oi}>
                      <input type="radio" name={`correct-${qi}`} aria-label={`Option ${oi + 1} is correct`} checked={(q.correctIndex ?? 0) === oi} onChange={() => setQuestions(questions.map((x, i) => (i === qi ? { ...x, correctIndex: oi } : x)))} />
                      <input aria-label={`Question ${qi + 1} option ${oi + 1}`} required maxLength={300} value={o} onChange={(e) => setQuestions(questions.map((x, i) => (i === qi ? { ...x, options: x.options.map((y, j) => (j === oi ? e.target.value : y)) } : x)))} />
                    </label>
                  ))}
                  {q.options.length < 6 ? <button type="button" className="sd-link-button" onClick={() => setQuestions(questions.map((x, i) => (i === qi ? { ...x, options: [...x.options, ''] } : x)))}>Add option</button> : null}
                </fieldset>
              ))}
              <div className="sd-inline">
                <button type="button" className="ghost-button" onClick={() => setQuestions([...questions, { id: `new-${questions.length}`, prompt: '', options: ['', ''], correctIndex: 0 }])}>Add question</button>
                <button type="submit" className="primary-button">Save quiz</button>
                {saved ? <span className="sd-ok" role="status">Saved</span> : null}
              </div>
              <p className="field-hint">The selected option is the correct answer. Learners never see which one it is.</p>
            </form>
          ) : null}
          {error ? <p className="field-error sd-panel-pad" role="alert">{error}</p> : null}
        </section>
      </div>
      <aside className="sd-side">
        <section className="cc-panel" aria-label="Course settings">
          <header><h3>Settings</h3><button type="button" className="sd-link-button" onClick={() => setEditingCourse(true)}>Edit</button></header>
          <dl className="sd-props">
            <dt>Status</dt><dd>{c.status}</dd>
            <dt>Quiz</dt><dd>{c.passMark === null ? 'None' : `Pass mark ${c.passMark}%`}</dd>
            <dt>Certification</dt><dd>{c.certificationName ?? 'None'}{c.validityMonths ? ` · ${c.validityMonths} months` : ''}</dd>
            <dt>Skills</dt><dd>{c.skills.length ? c.skills.map((s) => `${s.name} (${LEVELS[s.level]})`).join(', ') : 'None'}</dd>
          </dl>
        </section>
      </aside>
      {editingCourse ? <CourseDialog course={{ ...c, skills: c.skills.map((s) => ({ id: s.id, level: s.level })) }} onClose={() => setEditingCourse(false)} onSaved={() => { setEditingCourse(false); onChanged(); }} /> : null}
      {lesson ? <LessonDialog courseId={c.id} lesson={lesson === 'new' ? null : lesson} onClose={() => { setLesson(null); onChanged(); }} /> : null}
    </div>
  );
}

function LessonDialog({ courseId, lesson, onClose }: { courseId: string; lesson: Lesson | null; onClose: () => void }) {
  const [f, setF] = useState({ title: lesson?.title ?? '', body: lesson?.body ?? '', videoUrl: lesson?.videoUrl ?? '', minutes: lesson?.minutes ?? 5 });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog ac-editor" role="dialog" aria-modal="true" aria-labelledby="lesson-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { title: f.title, body: f.body, videoUrl: f.videoUrl || null, minutes: f.minutes };
          try { if (lesson) await api.put(`/academy/courses/${courseId}/lessons/${lesson.id}`, body); else await api.post(`/academy/courses/${courseId}/lessons`, body); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'The lesson was not saved.'); }
        }}>
        <h3 id="lesson-title">{lesson ? 'Edit lesson' : 'Add a lesson'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Title</span><input autoFocus required minLength={2} maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field"><span>Video link</span><input type="url" value={f.videoUrl} onChange={(e) => setF({ ...f, videoUrl: e.target.value })} placeholder="https://" /></label>
          <label className="field"><span>Minutes</span><input type="number" min={1} max={600} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} /></label>
          <label className="field sd-span-2"><span>Content</span><textarea required value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save</button></div>
      </form>
    </div>
  );
}

type ReportRow = { userId: string; name: string; status: string; source: string; dueAt: string | null; completedAt: string | null; score: number | null; attempts: number; lessonsDone: number; overdue: boolean };

function People({ course: c }: { course: CourseDetail }) {
  const key = `/academy/courses/${c.id}/report`;
  const report = useQuery<{ items: ReportRow[] }>(key, (s) => api.get(key, s));
  const people = useQuery<Paged<{ id: string; displayName: string }>>('/users?limit=100', (s) => api.get('/users?limit=100', s));
  const groups = useQuery<{ items: { id: string; name: string }[] }>('/engineering/teams', (s) => api.get('/engineering/teams', s));
  const [f, setF] = useState({ userIds: [] as string[], groupId: '', dueAt: '' });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="sd-detail-grid">
      <div className="sd-main">
        {report.loading && !report.data ? <Loading rows={3} /> : report.error && !report.data ? <ErrorState error={report.error} onRetry={report.reload} />
          : report.data!.items.length === 0 ? <Empty title="Nobody has started this course" description="Assign it, or wait for people to start it themselves." />
          : (
            <div className="sd-table-wrap">
              <table className="data-table sd-table">
                <thead><tr><th scope="col">Person</th><th scope="col">Progress</th><th scope="col">Due</th><th scope="col">Quiz</th></tr></thead>
                <tbody>{report.data!.items.map((r) => (
                  <tr key={r.userId}>
                    <th scope="row">{r.name}<span className="sd-sub">{r.source === 'assigned' ? 'Assigned' : 'Self-enrolled'}</span></th>
                    <td>{r.status === 'completed' ? <span className="ac-done"><CheckCircle2 size={14} aria-hidden="true" /> {r.completedAt ? formatDate(r.completedAt) : 'Done'}</span> : `${r.lessonsDone}/${c.lessons.length} lessons`}</td>
                    <td>{r.dueAt ? formatDate(r.dueAt) : '—'}{r.overdue ? <span className="sd-sub ac-bad">Overdue</span> : null}</td>
                    <td>{c.passMark === null ? '—' : r.score !== null ? `${r.score}% · ${r.attempts} ${r.attempts === 1 ? 'try' : 'tries'}` : 'Not taken'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
      </div>
      <aside className="sd-side">
        <section className="cc-panel" aria-label="Assign">
          <header><h3>Assign</h3></header>
          <form className="sd-panel-pad sd-editor" onSubmit={async (e) => {
            e.preventDefault(); setMessage(null);
            try {
              const res = await api.post<{ assigned: number }>(`/academy/courses/${c.id}/assign`, { userIds: f.userIds, groupId: f.groupId || null, dueAt: f.dueAt ? new Date(`${f.dueAt}T17:00`).toISOString() : null });
              setMessage({ ok: true, text: `Assigned to ${res.assigned} ${res.assigned === 1 ? 'person' : 'people'}.` });
              setF({ userIds: [], groupId: '', dueAt: '' });
            } catch (err) { setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Not assigned.' }); }
            invalidate('/academy/');
          }}>
            <label className="field"><span>A group</span><select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}><option value="">No group</option>{groups.data?.items.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
            <label className="field"><span>People</span>
              <select multiple size={6} value={f.userIds} onChange={(e) => setF({ ...f, userIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </label>
            <label className="field"><span>Due</span><input type="date" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></label>
            {message ? <p className={message.ok ? 'sd-ok' : 'field-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p> : null}
            <button type="submit" className="primary-button" disabled={c.status !== 'published' || (!f.groupId && f.userIds.length === 0)}>Assign</button>
            {c.status !== 'published' ? <p className="field-hint">Publish the course first.</p> : null}
          </form>
        </section>
      </aside>
    </div>
  );
}
