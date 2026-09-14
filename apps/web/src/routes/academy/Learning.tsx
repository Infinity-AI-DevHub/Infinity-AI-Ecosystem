/**
 * Academy home: what this person has to do (assigned training, policies to acknowledge,
 * certifications running out), then every course they can take. Also the certifications
 * and skills pages.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatDate } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/engineering.css';
import '../../styles/academy.css';

type Mine = {
  courses: { courseId: string; title: string; status: string; dueAt: string | null; completedAt: string | null; lessons: number; lessonsDone: number; overdue: boolean }[];
  policiesToAcknowledge: { id: string; title: string; dueAt: string | null; overdue: boolean }[];
  certificationsNeedingAttention: { id: string; name: string; expiresAt: string | null; state: string; courseId: string | null }[];
};
type Course = { id: string; title: string; summary: string | null; category: string | null; status: string; lessons: number; minutes: number; hasQuiz: boolean; certificationName: string | null; enrolled?: number; completed?: number; mine: { status: string; dueAt: string | null; lessonsDone: number } | null };

export const LEVELS = ['', 'Aware', 'Working', 'Practitioner', 'Expert'];

export default function Learning() {
  const { can } = useSession();
  const navigate = useNavigate();
  const me = useQuery<Mine>('/academy/me', (s) => api.get('/academy/me', s));
  const [q, setQ] = useState('');
  const key = `/academy/courses${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`;
  const courses = useQuery<{ items: Course[] }>(key, (s) => api.get(key, s));
  const [creating, setCreating] = useState(false);
  const open = me.data?.courses.filter((c) => c.status !== 'completed') ?? [];

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Academy</p><h2>My learning</h2></div>
        <div className="cc-header-side">{can('academy.manage') ? <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> New course</button> : null}</div>
      </header>

      {me.loading && !me.data ? <Loading rows={3} /> : me.error && !me.data ? <ErrorState error={me.error} onRetry={me.reload} /> : (
        <div className="cc-grid">
          <section className="cc-panel" aria-label="Training to do">
            <header><h3>Training to do</h3><span className="cc-meta">{open.length}</span></header>
            {open.length === 0 ? <p className="cc-empty">Nothing assigned or in progress.</p> : (
              <ul className="cc-rows">{open.map((c) => (
                <li key={c.courseId}><Link to={`/academy/courses/${c.courseId}`} className="cc-row">
                  <span className="cc-row-main"><strong>{c.title}</strong><span>{c.lessonsDone}/{c.lessons} lessons{c.dueAt ? ` · due ${formatDate(c.dueAt)}` : ''}</span></span>
                  {c.overdue ? <span className="cc-tag cc-tag-critical">Overdue</span> : null}
                </Link></li>
              ))}</ul>
            )}
          </section>
          <section className="cc-panel" aria-label="Policies to acknowledge">
            <header><h3>Policies to acknowledge</h3><span className="cc-meta">{me.data!.policiesToAcknowledge.length}</span></header>
            {me.data!.policiesToAcknowledge.length === 0 ? <p className="cc-empty">You are up to date.</p> : (
              <ul className="cc-rows">{me.data!.policiesToAcknowledge.map((p) => (
                <li key={p.id}><Link to={`/academy/policies/${p.id}`} className="cc-row">
                  <span className="cc-row-main"><strong>{p.title}</strong><span>{p.dueAt ? `By ${formatDate(p.dueAt)}` : ''}</span></span>
                  {p.overdue ? <span className="cc-tag cc-tag-critical">Overdue</span> : null}
                </Link></li>
              ))}</ul>
            )}
          </section>
          <section className="cc-panel" aria-label="Certifications">
            <header><h3>Certifications</h3><Link to="/academy/certifications" className="sd-link-button">All</Link></header>
            {me.data!.certificationsNeedingAttention.length === 0 ? <p className="cc-empty">None expired or expiring within 30 days.</p> : (
              <ul className="cc-rows">{me.data!.certificationsNeedingAttention.map((c) => (
                <li key={c.id}><Link to={c.courseId ? `/academy/courses/${c.courseId}` : '/academy/certifications'} className="cc-row">
                  <span className="cc-row-main"><strong>{c.name}</strong><span>{c.state === 'expired' ? 'Expired' : 'Expires'} {c.expiresAt ? formatDate(c.expiresAt) : ''}</span></span>
                  <span className={`cc-tag ${c.state === 'expired' ? 'cc-tag-critical' : ''}`}>{c.state}</span>
                </Link></li>
              ))}</ul>
            )}
          </section>
        </div>
      )}

      <div className="sd-toolbar">
        <h3 className="ac-section-title">Courses</h3>
        <div className="sd-filters"><input type="search" aria-label="Search courses" placeholder="Search courses" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {courses.loading && !courses.data ? <Loading rows={4} /> : courses.error && !courses.data ? <ErrorState error={courses.error} onRetry={courses.reload} />
        : courses.data!.items.length === 0 ? <Empty title={q ? 'No courses match' : 'No courses yet'} description={can('academy.manage') ? 'Create a course with lessons and an optional quiz.' : 'Courses appear here once they are published.'} />
        : (
          <div className="ac-courses">
            {courses.data!.items.map((c) => (
              <Link key={c.id} to={`/academy/courses/${c.id}`} className="ac-course">
                <span className="cc-meta">{c.category ?? 'General'}{c.status !== 'published' ? ` · ${c.status}` : ''}</span>
                <strong>{c.title}</strong>
                {c.summary ? <span className="ac-summary">{c.summary}</span> : null}
                <span className="ac-course-foot">
                  <span>{c.lessons} {c.lessons === 1 ? 'lesson' : 'lessons'} · {c.minutes} min{c.hasQuiz ? ' · quiz' : ''}</span>
                  {c.certificationName ? <span className="cc-tag cc-tag-info">Certifies</span> : null}
                  {c.mine?.status === 'completed' ? <span className="ac-done"><CheckCircle2 size={14} aria-hidden="true" /> Done</span> : c.mine ? <span>{c.mine.lessonsDone}/{c.lessons}</span> : null}
                  {c.enrolled !== undefined ? <span className="cc-meta">{c.completed}/{c.enrolled} completed</span> : null}
                </span>
              </Link>
            ))}
          </div>
        )}
      {creating ? <CourseDialog onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); invalidate('/academy/'); navigate(`/academy/courses/${id}`); }} /> : null}
    </div>
  );
}

type Skill = { id: string; name: string; category: string | null; description: string | null; people: number; experts: number; mine: { level: number; source: string; verified: boolean } | null };

export function CourseDialog({ course, onClose, onSaved }: { course?: { id: string; title: string; summary: string | null; category: string | null; passMark: number | null; certificationName: string | null; validityMonths: number | null; skills: { id: string; level: number }[] }; onClose: () => void; onSaved: (id: string) => void }) {
  const skills = useQuery<{ items: Skill[] }>('/academy/skills', (s) => api.get('/academy/skills', s));
  const [f, setF] = useState({
    title: course?.title ?? '', summary: course?.summary ?? '', category: course?.category ?? '', quiz: course ? course.passMark !== null : false, passMark: course?.passMark ?? 80,
    certifies: Boolean(course?.certificationName), certificationName: course?.certificationName ?? '', validityMonths: course?.validityMonths ?? 12,
    skills: course?.skills.map((s) => ({ skillId: s.id, level: s.level })) ?? [] as { skillId: string; level: number }[],
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="course-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { title: f.title, summary: f.summary || null, category: f.category || null, passMark: f.quiz ? f.passMark : null, certificationName: f.certifies ? f.certificationName : null, validityMonths: f.certifies && f.validityMonths ? f.validityMonths : null, skills: f.skills };
          try {
            if (course) { await api.put(`/academy/courses/${course.id}`, body); onSaved(course.id); }
            else { const res = await api.post<{ id: string }>('/academy/courses', body); onSaved(res.id); }
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The course was not saved.'); }
        }}>
        <h3 id="course-title">{course ? 'Edit course' : 'New course'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Title</span><input autoFocus required minLength={3} maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field sd-span-2"><span>Summary</span><input maxLength={500} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
          <label className="field"><span>Category</span><input maxLength={60} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Security" /></label>
          <span />
          <label className="sd-check"><input type="checkbox" checked={f.quiz} onChange={(e) => setF({ ...f, quiz: e.target.checked })} /> Has a quiz</label>
          {f.quiz ? <label className="field"><span>Pass mark (%)</span><input type="number" min={1} max={100} value={f.passMark} onChange={(e) => setF({ ...f, passMark: Number(e.target.value) })} /></label> : <span />}
          <label className="sd-check"><input type="checkbox" checked={f.certifies} onChange={(e) => setF({ ...f, certifies: e.target.checked })} /> Issues a certification</label>
          <span />
          {f.certifies ? <>
            <label className="field"><span>Certification name</span><input required maxLength={160} value={f.certificationName} onChange={(e) => setF({ ...f, certificationName: e.target.value })} /></label>
            <label className="field"><span>Valid for (months)</span><input type="number" min={1} max={120} value={f.validityMonths} onChange={(e) => setF({ ...f, validityMonths: Number(e.target.value) })} /></label>
          </> : null}
          <fieldset className="field sd-span-2">
            <legend>Skills it develops</legend>
            {skills.data?.items.length ? skills.data.items.map((s) => {
              const chosen = f.skills.find((x) => x.skillId === s.id);
              return (
                <div key={s.id} className="sd-inline">
                  <label className="sd-check"><input type="checkbox" checked={Boolean(chosen)} onChange={(e) => setF({ ...f, skills: e.target.checked ? [...f.skills, { skillId: s.id, level: 2 }] : f.skills.filter((x) => x.skillId !== s.id) })} /> {s.name}</label>
                  {chosen ? <select aria-label={`Level for ${s.name}`} value={chosen.level} onChange={(e) => setF({ ...f, skills: f.skills.map((x) => (x.skillId === s.id ? { ...x, level: Number(e.target.value) } : x)) })}>{[1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVELS[l]}</option>)}</select> : null}
                </div>
              );
            }) : <span className="field-hint">No skills in the register yet. Add them on the Skills page.</span>}
          </fieldset>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save</button></div>
      </form>
    </div>
  );
}

type Cert = { id: string; user: { id: string; name: string }; courseId: string | null; name: string; issuer: string | null; credentialUrl: string | null; issuedAt: string; expiresAt: string | null; source: string; verified: boolean; verifiedBy: string | null; state: 'valid' | 'expiring' | 'expired' };

export function Certifications() {
  const { can, session } = useSession();
  const manage = can('academy.manage');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const key = `/academy/certifications?scope=${scope}`;
  const list = useQuery<{ items: Cert[] }>(key, (s) => api.get(key, s));
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); } invalidate('/academy/'); };
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Academy</p><h2>Certifications</h2></div>
        <div className="cc-header-side"><button type="button" className="primary-button" onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" /> Add an outside certification</button></div>
      </header>
      {manage ? (
        <div className="tab-row" role="tablist" aria-label="Whose certifications">
          {(['mine', 'all'] as const).map((s) => <button key={s} type="button" role="tab" aria-selected={scope === s} className={`tab ${scope === s ? 'tab-active' : ''}`} onClick={() => setScope(s)}>{s === 'mine' ? 'Mine' : 'Everyone'}</button>)}
        </div>
      ) : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {list.loading && !list.data ? <Loading rows={4} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No certifications" description="Complete a certifying course, or add one you earned elsewhere for your manager to verify." />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Certification</th>{scope === 'all' ? <th scope="col">Person</th> : null}<th scope="col">Issued</th><th scope="col">Expires</th><th scope="col">Verified</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                {list.data!.items.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.credentialUrl ? <a href={c.credentialUrl} target="_blank" rel="noreferrer noopener">{c.name}</a> : c.name}<span className="sd-sub">{c.issuer ?? (c.source === 'course' ? 'Infinity Academy' : 'Outside')}</span></th>
                    {scope === 'all' ? <td>{c.user.name}</td> : null}
                    <td>{formatDate(c.issuedAt)}</td>
                    <td>{c.expiresAt ? <>{formatDate(c.expiresAt)}{c.state !== 'valid' ? <span className={`sd-sub ${c.state === 'expired' ? 'ac-bad' : 'ac-warn'}`}>{c.state === 'expired' ? 'Expired' : 'Expiring soon'}</span> : null}</> : 'Does not expire'}</td>
                    <td>{c.verified ? <span className="ac-done"><CheckCircle2 size={14} aria-hidden="true" /> {c.source === 'course' ? 'Earned here' : c.verifiedBy}</span> : <span className="ac-warn"><AlertTriangle size={14} aria-hidden="true" /> Awaiting verification</span>}</td>
                    <td>
                      {manage && !c.verified && c.user.id !== session?.user?.id ? <button type="button" className="sd-link-button" onClick={() => void act(() => api.post(`/academy/certifications/${c.id}/verify`, {}))}>Verify</button> : null}
                      {(c.user.id === session?.user?.id && c.source === 'external' && !c.verified) || manage ? <button type="button" className="sd-link-button" onClick={() => { if (window.confirm(`Remove ${c.name}?`)) void act(() => api.delete(`/academy/certifications/${c.id}`)); }}>Remove</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {adding ? <ExternalCertDialog onClose={() => { setAdding(false); invalidate('/academy/'); }} /> : null}
    </div>
  );
}

function ExternalCertDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', issuer: '', credentialUrl: '', issuedAt: '', expiresAt: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="cert-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { await api.post('/academy/certifications', { name: f.name, issuer: f.issuer || null, credentialUrl: f.credentialUrl || null, issuedAt: f.issuedAt, expiresAt: f.expiresAt || null }); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'Not added.'); }
        }}>
        <h3 id="cert-title">Add an outside certification</h3>
        <p className="field-hint">An academy manager verifies it before it counts as confirmed.</p>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Name</span><input autoFocus required minLength={2} maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="AWS Certified Solutions Architect" /></label>
          <label className="field"><span>Issuer</span><input maxLength={120} value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} /></label>
          <label className="field"><span>Credential link</span><input type="url" value={f.credentialUrl} onChange={(e) => setF({ ...f, credentialUrl: e.target.value })} placeholder="https://" /></label>
          <label className="field"><span>Issued</span><input type="date" required value={f.issuedAt} onChange={(e) => setF({ ...f, issuedAt: e.target.value })} /></label>
          <label className="field"><span>Expires</span><input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Add</button></div>
      </form>
    </div>
  );
}

type Holder = { userId: string; name: string; level: number; source: string; verified: boolean; verifiedBy: string | null; canVerify: boolean };

export function Skills() {
  const { can } = useSession();
  const list = useQuery<{ items: Skill[] }>('/academy/skills', (s) => api.get('/academy/skills', s));
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const holdersKey = selected ? `/academy/skills/${selected}/people` : null;
  const holders = useQuery<{ items: Holder[] }>(holdersKey, (s) => api.get(holdersKey!, s));
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work.'); } invalidate('/academy/skills'); };
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Academy</p><h2>Skills</h2></div>
        <div className="cc-header-side">{can('academy.manage') ? <button type="button" className="primary-button" onClick={() => setEditing('new')}><Plus size={15} aria-hidden="true" /> Add skill</button> : null}</div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {list.loading && !list.data ? <Loading rows={4} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No skills in the register" description={can('academy.manage') ? 'Add the skills the company wants to track.' : 'An academy manager adds the skills to track.'} />
        : (
          <div className="sd-detail-grid">
            <div className="sd-table-wrap">
              <table className="data-table sd-table">
                <thead><tr><th scope="col">Skill</th><th scope="col">People</th><th scope="col">My level</th></tr></thead>
                <tbody>
                  {list.data!.items.map((s) => (
                    <tr key={s.id} className={selected === s.id ? 'is-selected' : ''}>
                      <th scope="row"><button type="button" className="sd-link-button" onClick={() => setSelected(s.id)}>{s.name}</button><span className="sd-sub">{s.category ?? 'General'}{s.description ? ` · ${s.description}` : ''}</span></th>
                      <td>{s.people}{s.experts ? <span className="sd-sub">{s.experts} practitioner or expert</span> : null}</td>
                      <td>
                        <select aria-label={`My level in ${s.name}`} value={s.mine?.level ?? ''} onChange={(e) => void act(() => api.put(`/academy/skills/${s.id}/mine`, { level: e.target.value ? Number(e.target.value) : null }))}>
                          <option value="">Not recorded</option>{[1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVELS[l]}</option>)}
                        </select>
                        {s.mine ? <span className="sd-sub">{s.mine.verified ? (s.mine.source === 'course' ? 'Confirmed by a course' : 'Confirmed by a manager') : 'Self-assessed'}</span> : null}
                        {can('academy.manage') ? <button type="button" className="sd-link-button" onClick={() => setEditing(s)}>Edit</button> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <section className="cc-panel" aria-label="People with this skill">
              <header><h3>{selected ? list.data!.items.find((s) => s.id === selected)?.name : 'People'}</h3></header>
              {!selected ? <p className="cc-empty">Choose a skill to see who has it.</p> : !holders.data ? <Loading rows={2} /> : holders.data.items.length === 0 ? <p className="cc-empty">Nobody has recorded it yet.</p> : (
                <ul className="cc-rows">{holders.data.items.map((h) => (
                  <li key={h.userId} className="cc-row">
                    <span className="cc-row-main"><strong>{h.name}</strong><span>{LEVELS[h.level]} · {h.verified ? (h.source === 'course' ? 'course' : `confirmed by ${h.verifiedBy}`) : 'self-assessed'}</span></span>
                    {h.canVerify ? <button type="button" className="sd-link-button" onClick={() => void act(async () => { await api.post(`/academy/skills/${selected}/people/${h.userId}/verify`, {}); invalidate(`/academy/skills/${selected}`); })}>Confirm</button> : null}
                  </li>
                ))}</ul>
              )}
            </section>
          </div>
        )}
      {editing ? <SkillDialog skill={editing === 'new' ? null : editing} onClose={() => { setEditing(null); invalidate('/academy/skills'); }} /> : null}
    </div>
  );
}

function SkillDialog({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const [f, setF] = useState({ name: skill?.name ?? '', category: skill?.category ?? '', description: skill?.description ?? '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { name: f.name, category: f.category || null, description: f.description || null };
          try { if (skill) await api.put(`/academy/skills/${skill.id}`, body); else await api.post('/academy/skills', body); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'Not saved.'); }
        }}>
        <h3 id="skill-title">{skill ? 'Edit skill' : 'Add a skill'}</h3>
        {skill?.people ? <p className="field-hint">{skill.people} {skill.people === 1 ? 'person has' : 'people have'} this skill recorded.</p> : null}
        <div className="sd-form-grid">
          <label className="field"><span>Name</span><input autoFocus required minLength={2} maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>Category</span><input maxLength={60} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></label>
          <label className="field sd-span-2"><span>Description</span><input maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {skill ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete ${skill.name}? It is removed from everyone's skills and from the courses that teach it.`)) return;
            try { await api.delete(`/academy/skills/${skill.id}`); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save</button></div>
      </form>
    </div>
  );
}

