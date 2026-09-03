/**
 * The dashboard an employee sees.
 *
 * The command centre answers a manager's questions — approvals waiting, storage used,
 * what the company announced. An employee arrives with different ones: am I clocked in,
 * what is assigned to me, am I keeping up, what is on today. Showing them the manager's
 * page meant a screen where most panels were either empty or none of their business.
 *
 * Everything here is the person's own: their tasks, their hours, their meetings.
 */
import { Link } from 'react-router-dom';
import {
  AlertTriangle, CalendarDays, CheckCircle2, CheckSquare, Clock, Megaphone, Play, Square,
} from 'lucide-react';
import { useState } from 'react';
import { api, type Widget } from '../lib/api';
import { useQuery } from '../lib/query';
import { ErrorState, Loading } from '../components/States';
import { useSession } from '../lib/session';
import { useNotify } from '../lib/notify';
import { formatTime, relativeTime } from '../lib/format';
import { TaskPriority } from '../components/TaskPriority';
import { useAttendance, formatElapsed, formatMinutes } from '../lib/attendance';
import { LiveClock } from '../components/LiveClock';

type Meeting = {
  id: string; title: string; starts_at: string; ends_at: string;
  timezone: string; has_video: boolean; rsvp: string;
};
type Task = {
  id: string; title: string; status: string; priority: string;
  due_at: string | null; project_key: string; number: number;
};
type Announcement = {
  id: string; title: string; body: string; priority: string; publish_at: string;
};
type Work = {
  openTasks: number; dueSoon: number; overdue: number;
  doneThisWeek: number; completionRate: number | null;
};
type Attendance = {
  minimumMinutes: number; todayMinutes: number; weekMinutes: number;
  daysMetMinimum: number; workingDaysRecorded: number;
  days: { day: string; minutes: number; workingDay: boolean }[];
};

type Dashboard = {
  meetings: Widget<Meeting[]>;
  tasks: Widget<Task[]>;
  announcements: Widget<Announcement[]>;
  work: Widget<Work>;
  attendance: Widget<Attendance>;
};

/** A widget that failed says so in its own corner rather than taking the page down. */
function Panel<T>({ widget, children }: { widget: Widget<T>; children: (data: T) => React.ReactNode }) {
  if (widget.state === 'unavailable') {
    return <p className="widget-unavailable" role="status">{widget.reason}</p>;
  }
  return <>{children(widget.data)}</>;
}

export default function EmployeeHome() {
  const { session } = useSession();
  const dashboard = useQuery<Dashboard>('/me/dashboard', (signal) => api.get('/me/dashboard', signal), {
    ttlMs: 15_000,
  });

  if (dashboard.loading) return <Loading label="Loading your day" rows={5} />;
  if (dashboard.error) return <ErrorState error={dashboard.error} onRetry={dashboard.reload} />;
  if (!dashboard.data) return <Loading />;

  const data = dashboard.data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = session?.user?.displayName.split(' ')[0] ?? '';

  return (
    <div className="module-page employee-home">
      <header className="module-header">
        <div>
          <h2>{greeting}{firstName ? `, ${firstName}` : ''}</h2>
          <p>Here is your day.</p>
        </div>
        <LiveClock />
      </header>

      <div className="employee-grid">
        <ClockCard onChanged={() => dashboard.reload()} />

        <Panel widget={data.attendance}>
          {(attendance) => <HoursCard attendance={attendance} />}
        </Panel>

        <Panel widget={data.work}>
          {(work) => <WorkCard work={work} />}
        </Panel>
      </div>

      <div className="split-layout">
        <section className="panel panel-scroll" aria-label="Your tasks">
          <header className="panel-header">
            <span className="panel-title">Assigned to you</span>
            <Link to="/tasks" className="link-button">Open the board</Link>
          </header>
          <Panel widget={data.tasks}>
            {(tasks) =>
              tasks.length === 0 ? (
                <p className="field-hint">Nothing assigned to you right now.</p>
              ) : (
                <ul className="employee-task-list">
                  {tasks.slice(0, 8).map((task) => (
                    <li key={task.id}>
                      <Link to={`/tasks/${task.id}`}>
                        <TaskPriority priority={task.priority} />
                        <strong>{task.title}</strong>
                        <span className="task-meta">
                          {task.project_key}-{task.number}
                          {task.due_at ? ` · due ${relativeTime(task.due_at)}` : ''}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            }
          </Panel>
        </section>

        <section className="panel panel-scroll" aria-label="Your meetings">
          <header className="panel-header">
            <span className="panel-title">Coming up</span>
            <Link to="/meetings" className="link-button">Open the calendar</Link>
          </header>
          <Panel widget={data.meetings}>
            {(meetings) =>
              meetings.length === 0 ? (
                <p className="field-hint">Nothing in your calendar today.</p>
              ) : (
                <ul className="employee-meeting-list">
                  {meetings.slice(0, 6).map((meeting) => (
                    <li key={meeting.id}>
                      <CalendarDays size={15} aria-hidden="true" />
                      <span>
                        <strong>{meeting.title}</strong>
                        <span className="field-hint">
                          {formatTime(meeting.starts_at, meeting.timezone)} ·{' '}
                          {relativeTime(meeting.starts_at)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Panel>
        </section>
      </div>

      <section className="panel panel-scroll" aria-label="Announcements">
        <header className="panel-header">
          <span className="panel-title">Announcements</span>
          <Link to="/announcements" className="link-button">See all</Link>
        </header>
        <Panel widget={data.announcements}>
          {(announcements) =>
            announcements.length === 0 ? (
              <p className="field-hint">Nothing new from the company.</p>
            ) : (
              <ul className="employee-notice-list">
                {announcements.slice(0, 4).map((notice) => (
                  <li key={notice.id} className={`employee-notice notice-${notice.priority}`}>
                    <Megaphone size={15} aria-hidden="true" />
                    <span>
                      <strong>{notice.title}</strong>
                      <span className="field-hint">{relativeTime(notice.publish_at)}</span>
                      <span className="employee-notice-body">{notice.body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </Panel>
      </section>
    </div>
  );
}

/**
 * Clocking in and out without leaving the page you land on.
 *
 * Attendance is the first thing an employee does and the last, and making them navigate
 * to a module for it meant a step people forgot — and a forgotten clock-out is the one
 * that gets flagged.
 */
function ClockCard({ onChanged }: { onChanged: () => void }) {
  const { open, elapsedSeconds, clockIn } = useAttendance();
  const { notify } = useNotify();
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      await clockIn();
      notify({ severity: 'success', title: 'Clocked in' });
      onChanged();
    } catch {
      notify({ severity: 'warning', title: 'Could not clock in' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel employee-card employee-clock">
      <span className="employee-card-label">
        {open ? 'Clocked in' : 'Not clocked in'}
      </span>
      <strong className={`clock-elapsed ${open ? 'is-running' : ''}`}>
        {open ? formatElapsed(elapsedSeconds) : '--:--:--'}
      </strong>
      {open ? (
        <>
          <span className="field-hint">Keep the app open until you clock out.</span>
          {/* Clocking out asks for a note and evidence, so it belongs on the attendance
              page rather than behind a one-click button here. */}
          <Link to="/attendance" className="danger-button employee-clock-button">
            <Square size={15} aria-hidden="true" /> Clock out
          </Link>
        </>
      ) : (
        <>
          <span className="field-hint">Start the clock when you begin work.</span>
          <button
            type="button"
            className="primary-button employee-clock-button"
            disabled={busy}
            onClick={() => void start()}
          >
            <Play size={15} aria-hidden="true" /> {busy ? 'Clocking in…' : 'Clock in'}
          </button>
        </>
      )}
    </article>
  );
}

/** Today against the six-hour minimum, and the week behind it. */
function HoursCard({ attendance }: { attendance: Attendance }) {
  const met = attendance.todayMinutes >= attendance.minimumMinutes;
  const pct = Math.min(100, (attendance.todayMinutes / attendance.minimumMinutes) * 100);
  const peak = Math.max(attendance.minimumMinutes, ...attendance.days.map((d) => d.minutes), 1);

  return (
    <article className="panel employee-card">
      <span className="employee-card-label">Hours today</span>
      <strong className="employee-card-value">{formatMinutes(attendance.todayMinutes)}</strong>
      <div className="clock-bar" role="img"
           aria-label={`${formatMinutes(attendance.todayMinutes)} of ${formatMinutes(attendance.minimumMinutes)}`}>
        <span style={{ width: `${pct}%` }} className={met ? 'is-met' : ''} />
      </div>
      <span className="field-hint">
        {met
          ? <><CheckCircle2 size={12} aria-hidden="true" /> Past the {formatMinutes(attendance.minimumMinutes)} minimum</>
          : `${formatMinutes(attendance.minimumMinutes - attendance.todayMinutes)} to go`}
      </span>

      {/* Seven days at a glance: the shape of the week matters more than any one day. */}
      <div className="employee-week" aria-hidden="true">
        {attendance.days.map((day) => (
          <span key={day.day} className="employee-week-day" title={`${day.day}: ${formatMinutes(day.minutes)}`}>
            <span
              className={day.minutes >= attendance.minimumMinutes ? 'is-met' : ''}
              style={{ height: `${Math.max(4, (day.minutes / peak) * 100)}%` }}
            />
          </span>
        ))}
      </div>
      <span className="field-hint">
        {formatMinutes(attendance.weekMinutes)} this week ·{' '}
        {attendance.daysMetMinimum} of {attendance.workingDaysRecorded} days met
      </span>
    </article>
  );
}

/** What is on their plate, and how it is going. */
function WorkCard({ work }: { work: Work }) {
  return (
    <article className="panel employee-card">
      <span className="employee-card-label">Your work</span>
      <strong className="employee-card-value">{work.openTasks}</strong>
      <span className="field-hint">
        open {work.openTasks === 1 ? 'task' : 'tasks'}
      </span>

      <ul className="employee-stats">
        <li>
          <CheckSquare size={13} aria-hidden="true" />
          {work.doneThisWeek} finished this week
        </li>
        <li>
          <Clock size={13} aria-hidden="true" />
          {work.dueSoon} due within a week
        </li>
        {work.overdue > 0 ? (
          <li className="is-overdue">
            <AlertTriangle size={13} aria-hidden="true" />
            {work.overdue} past its due date
          </li>
        ) : null}
      </ul>

      {work.completionRate !== null ? (
        <>
          <div className="clock-bar" role="img" aria-label={`${work.completionRate}% completed this month`}>
            <span style={{ width: `${work.completionRate}%` }} className="is-met" />
          </div>
          <span className="field-hint">{work.completionRate}% of this month&rsquo;s work finished</span>
        </>
      ) : null}
    </article>
  );
}
