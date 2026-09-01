/**
 * Command centre (blueprint 04).
 *
 * Each widget loads independently and degrades on its own, so one unavailable service
 * cannot blank the page.
 */
import { Link } from 'react-router-dom';
import { CalendarDays, CheckSquare, Megaphone, ShieldCheck, HardDrive } from 'lucide-react';
import { api, type Widget } from '../lib/api';
import { TaskPriority } from '../components/TaskPriority';
import { useQuery } from '../lib/query';
import { Loading, ErrorState } from '../components/States';
import { useSession } from '../lib/session';
import { formatBytes, formatTime, relativeTime, titleCase } from '../lib/format';

type Dashboard = {
  meetings: Widget<
    { id: string; title: string; starts_at: string; ends_at: string; timezone: string; has_video: boolean; rsvp: string }[]
  >;
  tasks: Widget<
    { id: string; title: string; status: string; priority: string; due_at: string | null; project_key: string; number: number }[]
  >;
  approvals: Widget<{ awaiting: number; mine_pending: number }>;
  notifications: Widget<{ unread: number }>;
  announcements: Widget<
    { id: string; title: string; body: string; priority: string; publish_at: string; author_name: string | null }[]
  >;
  storage: Widget<{ usedBytes: number; fileCount: number }>;
};

/** Renders a widget's own unavailable state rather than failing the whole page. */
function WidgetBody<T>({ widget, children }: { widget: Widget<T>; children: (data: T) => React.ReactNode }) {
  if (widget.state === 'unavailable') {
    return <p className="widget-unavailable" role="status">{widget.reason}</p>;
  }
  return <>{children(widget.data)}</>;
}

export default function Command() {
  const { session } = useSession();
  const dashboard = useQuery<Dashboard>('/me/dashboard', (signal) => api.get('/me/dashboard', signal), {
    ttlMs: 15_000,
  });

  if (dashboard.loading) return <Loading label="Loading your command centre" rows={5} />;
  if (dashboard.error) return <ErrorState error={dashboard.error} onRetry={dashboard.reload} />;
  if (!dashboard.data) return <Loading />;

  const data = dashboard.data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = session?.user?.displayName.split(' ')[0] ?? '';

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>{greeting}{firstName ? `, ${firstName}` : ''}</h2>
          <p>Here is what needs you today.</p>
        </div>
      </header>

      <section className="metric-row" aria-label="Summary">
        <Link to="/approvals" className="metric-card">
          <ShieldCheck size={18} aria-hidden="true" />
          <WidgetBody widget={data.approvals}>
            {(approvals) => (
              <>
                <strong>{approvals.awaiting}</strong>
                <span>Awaiting your decision</span>
              </>
            )}
          </WidgetBody>
        </Link>

        <Link to="/tasks" className="metric-card">
          <CheckSquare size={18} aria-hidden="true" />
          <WidgetBody widget={data.tasks}>
            {(tasks) => (
              <>
                <strong>{tasks.length}</strong>
                <span>Open tasks assigned to you</span>
              </>
            )}
          </WidgetBody>
        </Link>

        <Link to="/files" className="metric-card">
          <HardDrive size={18} aria-hidden="true" />
          <WidgetBody widget={data.storage}>
            {(storage) => (
              <>
                <strong>{formatBytes(storage.usedBytes)}</strong>
                <span>{storage.fileCount} files stored</span>
              </>
            )}
          </WidgetBody>
        </Link>
      </section>

      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="today-heading">
          <header className="panel-header">
            <div>
              <CalendarDays size={16} aria-hidden="true" />
              <h3 id="today-heading">Next 24 hours</h3>
            </div>
            <Link to="/meetings" className="ghost-button">Open calendar</Link>
          </header>
          <WidgetBody widget={data.meetings}>
            {(meetings) =>
              meetings.length === 0 ? (
                <p className="panel-empty">Nothing scheduled. A clear day.</p>
              ) : (
                <ul className="meeting-list">
                  {meetings.map((meeting) => (
                    <li key={meeting.id}>
                      <Link to={`/meetings/${meeting.id}`}>
                        <time dateTime={meeting.starts_at}>{formatTime(meeting.starts_at)}</time>
                        <div>
                          <strong>{meeting.title}</strong>
                          <span>
                            {meeting.has_video ? 'Video meeting' : 'In person'}
                            {meeting.rsvp === 'needs_action' ? ' · Response needed' : ''}
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            }
          </WidgetBody>
        </section>

        <section className="panel" aria-labelledby="tasks-heading">
          <header className="panel-header">
            <div>
              <CheckSquare size={16} aria-hidden="true" />
              <h3 id="tasks-heading">Your tasks</h3>
            </div>
            <Link to="/tasks" className="ghost-button">Open board</Link>
          </header>
          <WidgetBody widget={data.tasks}>
            {(tasks) =>
              tasks.length === 0 ? (
                <p className="panel-empty">No open tasks assigned to you.</p>
              ) : (
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <Link to={`/tasks/${task.id}`}>
                        <TaskPriority priority={task.priority} />
                        <div>
                          <strong>{task.title}</strong>
                          <span>
                            {task.project_key}-{task.number} · {titleCase(task.status)}
                            {task.due_at ? ` · due ${relativeTime(task.due_at)}` : ''}
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            }
          </WidgetBody>
        </section>

        <section className="panel" aria-labelledby="announcements-heading">
          <header className="panel-header">
            <div>
              <Megaphone size={16} aria-hidden="true" />
              <h3 id="announcements-heading">Announcements</h3>
            </div>
            <Link to="/announcements" className="ghost-button">See all</Link>
          </header>
          <WidgetBody widget={data.announcements}>
            {(announcements) =>
              announcements.length === 0 ? (
                <p className="panel-empty">No current announcements.</p>
              ) : (
                <ul className="announcement-list">
                  {announcements.map((announcement) => (
                    <li key={announcement.id} className={`priority-${announcement.priority}`}>
                      <Link to={`/announcements/${announcement.id}`}>
                        <strong>{announcement.title}</strong>
                      </Link>
                      <p>{announcement.body.slice(0, 220)}</p>
                      <span>
                        {announcement.author_name ?? 'Workspace'} ·{' '}
                        <time dateTime={announcement.publish_at}>
                          {relativeTime(announcement.publish_at)}
                        </time>
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </WidgetBody>
        </section>
      </div>
    </div>
  );
}
