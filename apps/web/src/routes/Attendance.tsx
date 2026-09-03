/**
 * Attendance: your own record, and — for a reviewer — everyone's.
 *
 * The clock is the first thing on the page because it is the thing people came to press.
 * Everything else is the record it produces.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Play, Square } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { invalidate, useQuery } from '../lib/query';
import { AsyncSection, Empty } from '../components/States';
import { useSession } from '../lib/session';
import { useNotify } from '../lib/notify';
import { formatDateTime } from '../lib/format';
import { useAttendance, formatElapsed, formatMinutes, type AttendanceDay } from '../lib/attendance';
import { FilePreview, type PreviewTarget } from '../components/FilePreview';
import { LiveClock } from '../components/LiveClock';
import { EvidenceUpload, EvidenceList, type AttachedFile } from '../components/EvidenceUpload';

type Session = {
  id: string;
  user_id: string;
  display_name?: string;
  day?: string;
  clocked_in_at: string;
  clocked_out_at: string | null;
  worked_minutes: number | null;
  close_reason: string;
  note: string | null;
  flagged: number;
  flag_reason: string | null;
  review_state: string;
  review_note: string | null;
  reviewer_name?: string | null;
  evidence_count?: number;
};

const STATE_TAG: Record<string, string> = {
  pending: 'status-pending',
  approved: 'status-active',
  disqualified: 'status-error',
};

export default function Attendance() {
  const { can } = useSession();
  const [tab, setTab] = useState<'me' | 'review'>('me');
  const canReview = can('attendance.review');

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Attendance</h2>
          <p>Clock in when you start, and show what you did when you stop.</p>
        </div>
        {canReview ? (
          <div className="tab-row" role="tablist" aria-label="Attendance view">
            {(['me', 'review'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={tab === mode}
                className={`tab ${tab === mode ? 'tab-active' : ''}`}
                onClick={() => setTab(mode)}
              >
                {mode === 'me' ? 'My time' : 'Review'}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {tab === 'me' || !canReview ? <MyTime /> : <ReviewQueue />}
    </div>
  );
}

/** Saturday and Sunday. Only used before the server's own answer has arrived. */
function isWeekend(date: Date): boolean {
  const weekday = date.getDay();
  return weekday === 0 || weekday === 6;
}

/* ------------------------------------------------------------------ my time */

function MyTime() {
  const { open, today, minimumMinutes, elapsedSeconds, clockIn, refresh } = useAttendance();
  const { notify } = useNotify();
  const [clockingOut, setClockingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const history = useQuery<{ sessions: Session[]; days: AttendanceDay[] }>(
    '/attendance/me?days=30',
    (signal) => api.get('/attendance/me?days=30', signal),
  );

  // Live minutes: today's stored total plus the session that is still running.
  const liveMinutes = today?.minutes ?? 0;
  // A weekend is not a working day, so nothing is owed on one — but the clock still runs
  // and the time is still recorded for anyone who chooses to work.
  const workingDay = today?.workingDay ?? isWeekend(new Date()) === false;
  const met = !workingDay || liveMinutes >= minimumMinutes;

  async function start() {
    setError(null);
    setBusy(true);
    try {
      await clockIn();
      history.reload();
      notify({ severity: 'success', title: 'Clocked in' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clock in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel clock-panel" aria-label="Your clock">
        <div className="clock-face">
          <span className="clock-label">
            {open ? 'Clocked in' : 'Not clocked in'}
          </span>
          <strong className={`clock-elapsed ${open ? 'is-running' : ''}`}>
            {open ? formatElapsed(elapsedSeconds) : '--:--:--'}
          </strong>
          {open ? (
            <span className="field-hint">
              Since {formatDateTime(open.clocked_in_at)}. Keep the app open — closing it
              clocks you out automatically, with no note or evidence.
            </span>
          ) : (
            <span className="field-hint">
              Clock in when you start working. You can minimise the app, but do not close it.
            </span>
          )}
        </div>

        <div className="clock-actions">
          {open ? (
            <button type="button" className="danger-button" onClick={() => setClockingOut(true)}>
              <Square size={15} aria-hidden="true" /> Clock out
            </button>
          ) : (
            <button type="button" className="primary-button" disabled={busy} onClick={() => void start()}>
              <Play size={15} aria-hidden="true" /> {busy ? 'Clocking in…' : 'Clock in'}
            </button>
          )}
        </div>

        <div className="clock-today">
          <span className="clock-today-label">Today</span>
          <strong>{formatMinutes(liveMinutes)}</strong>
          <div className="clock-bar" role="img"
               aria-label={`${formatMinutes(liveMinutes)} of ${formatMinutes(minimumMinutes)}`}>
            <span style={{ width: `${Math.min(100, (liveMinutes / minimumMinutes) * 100)}%` }}
                  className={met ? 'is-met' : ''} />
          </div>
          <span className="field-hint">
            {!workingDay
              ? 'Weekends are not working days. Your time is still recorded, but no minimum applies.'
              : met
                ? `You have passed the ${formatMinutes(minimumMinutes)} minimum for today.`
                : `${formatMinutes(Math.max(0, minimumMinutes - liveMinutes))} left of the ${formatMinutes(minimumMinutes)} daily minimum.`}
          </span>
        </div>
      </section>

      {error ? <p className="field-error">{error}</p> : null}

      <AsyncSection query={history}>
        {(data) => (
          <div className="split-layout">
            <section className="panel panel-scroll" aria-label="Days">
              <header className="panel-header"><span className="panel-title">Last 30 days</span></header>
              {data.days.length === 0 ? (
                <p className="field-hint">Nothing recorded yet.</p>
              ) : (
                <ul className="day-list">
                  {data.days.map((day) => (
                    <li key={day.day}>
                      <span className="day-date">{day.day}</span>
                      <span className={`day-total ${
                        !day.workingDay ? '' : day.meetsMinimum ? 'is-met' : 'is-short'}`}>
                        {formatMinutes(day.minutes)}
                      </span>
                      <span className="field-hint">
                        {day.sessions} {day.sessions === 1 ? 'session' : 'sessions'}
                        {day.workingDay ? '' : ' · weekend'}
                      </span>
                      {day.flagged ? (
                        <span className="thread-flag thread-flag-warn">
                          <AlertTriangle size={11} aria-hidden="true" /> Needs review
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel panel-scroll" aria-label="Sessions">
              <header className="panel-header"><span className="panel-title">Sessions</span></header>
              {data.sessions.length === 0 ? (
                <Empty title="No sessions yet" description="They appear here once you clock out." />
              ) : (
                <ul className="session-list">
                  {data.sessions.map((s) => <SessionRow key={s.id} session={s} />)}
                </ul>
              )}
            </section>
          </div>
        )}
      </AsyncSection>

      {clockingOut ? (
        <ClockOutDialog
          onClose={() => setClockingOut(false)}
          onDone={() => {
            setClockingOut(false);
            void refresh();
            history.reload();
          }}
        />
      ) : null}
    </>
  );
}

function SessionRow({ session }: { session: Session }) {
  return (
    <li>
      <div className="session-when">
        <strong>{formatDateTime(session.clocked_in_at)}</strong>
        <span className="field-hint">
          {session.clocked_out_at
            ? `until ${formatDateTime(session.clocked_out_at)} · ${formatMinutes(session.worked_minutes ?? 0)}`
            : 'still running'}
          {session.close_reason === 'auto' ? ' · closed automatically' : ''}
        </span>
      </div>
      <span className={`status-tag ${STATE_TAG[session.review_state] ?? 'status-pending'}`}>
        {session.review_state}
      </span>
      {session.flagged ? (
        <span className="field-hint session-flag">{session.flag_reason}</span>
      ) : null}
      {session.review_note ? (
        <span className="field-hint session-flag">Reviewer: {session.review_note}</span>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------- clocking out */

/**
 * Clocking out is where the record is made, so both halves are asked for here: what was
 * done, and something that shows it. Neither is enforced — refusing would throw the time
 * away — but the consequence of leaving one out is stated before you commit.
 */
function ClockOutDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { notify } = useNotify();
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const incomplete = !note.trim() || files.length === 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post('/attendance/clock-out', {
        note: note.trim() || null,
        evidenceFileIds: files.map((f) => f.id),
      });
      invalidate('/attendance');
      notify({
        severity: incomplete ? 'warning' : 'success',
        title: incomplete ? 'Clocked out — flagged for review' : 'Clocked out',
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clock out');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="Clock out"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Clock out</h3>
        <p className="field-hint">
          Say what you worked on and attach something that shows it — screenshots, a
          document, whatever the work produced.
        </p>

        <label className="field">
          <span>What did you do today?</span>
          <textarea
            rows={5}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="The pages you built, the bugs you fixed, who you met…"
          />
        </label>

        <EvidenceUpload
          files={files}
          onChange={setFiles}
          hint="Screenshots, a document, whatever the work produced."
        />

        {/* Said before they commit, not after: the flag is a consequence they can avoid. */}
        {incomplete ? (
          <p className="degraded-notice" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            {!note.trim() && files.length === 0
              ? ' Without a note and evidence this will be flagged for an administrator.'
              : !note.trim()
                ? ' Without a note this will be flagged for an administrator.'
                : ' Without evidence this will be flagged for an administrator.'}
          </p>
        ) : null}

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Keep working</button>
          <button type="submit" className={incomplete ? 'danger-button' : 'primary-button'} disabled={saving}>
            {saving ? 'Clocking out…' : incomplete ? 'Clock out anyway' : 'Clock out'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------- review queue */

function ReviewQueue() {
  const [state, setState] = useState<'pending' | 'approved' | 'disqualified' | 'all'>('pending');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const key = `/attendance?days=60&limit=100${state === 'all' ? '' : `&state=${state}`}${
    flaggedOnly ? '&flaggedOnly=true' : ''}`;
  const list = useQuery<{ items: Session[] }>(key, (signal) => api.get(key, signal));

  return (
    <>
      <div className="filter-row">
        {(['pending', 'approved', 'disqualified', 'all'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`chip ${state === value ? 'chip-active' : ''}`}
            onClick={() => setState(value)}
          >
            {value === 'all' ? 'All' : value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
        <label className="checkbox-row">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
          Flagged only
        </label>
      </div>

      <AsyncSection query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty title="Nothing to review" description="Flagged and pending sessions appear here." />
          ) : (
            <section className="panel panel-scroll" aria-label="Attendance records">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Day</th>
                    <th scope="col">Worked</th>
                    <th scope="col">Evidence</th>
                    <th scope="col">State</th>
                    <th scope="col"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">
                        {s.display_name}
                        {s.flagged ? (
                          <span className="thread-flag thread-flag-warn">
                            <AlertTriangle size={11} aria-hidden="true" /> Flagged
                          </span>
                        ) : null}
                      </th>
                      <td>{s.day}</td>
                      <td>{formatMinutes(s.worked_minutes ?? 0)}</td>
                      <td>{s.evidence_count ?? 0}</td>
                      <td>
                        <span className={`status-tag ${STATE_TAG[s.review_state] ?? 'status-pending'}`}>
                          {s.review_state}
                        </span>
                      </td>
                      <td className="table-actions">
                        <button type="button" className="ghost-button" onClick={() => setOpenId(s.id)}>
                          Review
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )
        }
      </AsyncSection>

      {openId ? (
        <ReviewDialog
          sessionId={openId}
          onClose={() => setOpenId(null)}
          onReviewed={() => { setOpenId(null); list.reload(); }}
        />
      ) : null}
    </>
  );
}

type SessionDetail = Session & {
  evidence: { id: string; file_id: string; name: string; mime_type: string | null; size_bytes: number }[];
};

function ReviewDialog({
  sessionId, onClose, onReviewed,
}: { sessionId: string; onClose: () => void; onReviewed: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null);

  useEffect(() => {
    void api.get<SessionDetail>(`/attendance/${sessionId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load it'));
  }, [sessionId]);

  async function decide(state: 'approved' | 'disqualified') {
    setError(null);
    setSaving(true);
    try {
      await api.post(`/attendance/${sessionId}/review`, { state, note: note.trim() || null });
      onReviewed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That decision could not be recorded');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-label="Review work session"
           onClick={(e) => e.stopPropagation()}>
        <h3>Review work session</h3>

        {!detail ? (
          <p className="field-hint">Loading…</p>
        ) : (
          <>
            <dl className="detail-list">
              <div><dt>Person</dt><dd>{detail.display_name}</dd></div>
              <div><dt>Day</dt><dd>{detail.day}</dd></div>
              <div>
                <dt>Clocked in</dt>
                <dd>{formatDateTime(detail.clocked_in_at)}</dd>
              </div>
              <div>
                <dt>Clocked out</dt>
                <dd>
                  {detail.clocked_out_at ? formatDateTime(detail.clocked_out_at) : 'still running'}
                  {detail.close_reason === 'auto' ? ' (automatic)' : ''}
                </dd>
              </div>
              <div><dt>Worked</dt><dd>{formatMinutes(detail.worked_minutes ?? 0)}</dd></div>
            </dl>

            {detail.flagged ? (
              <p className="degraded-notice" role="alert">
                <AlertTriangle size={14} aria-hidden="true" /> {detail.flag_reason}
              </p>
            ) : null}

            <section className="task-block">
              <h4>What they said they did</h4>
              {detail.note ? (
                <p className="message-text">{detail.note}</p>
              ) : (
                <p className="field-hint">Nothing was written.</p>
              )}
            </section>

            <section className="task-block">
              <h4>
                Evidence
                {detail.evidence.length > 0 ? (
                  <span className="count-badge">{detail.evidence.length}</span>
                ) : null}
              </h4>
              <EvidenceList
                items={detail.evidence}
                onOpen={setPreviewing}
                emptyText="Nothing was attached."
              />
            </section>

            <label className="field">
              <span>Note for them</span>
              <textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Required when disqualifying — say what was missing."
              />
            </label>

            {error ? <p className="field-error">{error}</p> : null}

            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={onClose}>Close</button>
              <button type="button" className="danger-button" disabled={saving}
                      onClick={() => void decide('disqualified')}>
                Disqualify
              </button>
              <button type="button" className="primary-button" disabled={saving}
                      onClick={() => void decide('approved')}>
                <CheckCircle2 size={15} aria-hidden="true" /> Approve work
              </button>
            </div>
          </>
        )}

        {previewing ? (
          <FilePreview target={previewing} onClose={() => setPreviewing(null)} />
        ) : null}
      </div>
    </div>
  );
}

/** The live clock for the dashboard. */
export function DateTimeCard() {
  const { open, elapsedSeconds } = useAttendance();
  return (
    <LiveClock>
      <span className="field-hint">
        {open ? `Clocked in · ${formatElapsed(elapsedSeconds)}` : 'Not clocked in'}
      </span>
    </LiveClock>
  );
}
