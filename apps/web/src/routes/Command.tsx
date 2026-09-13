/**
 * Command centre (blueprint 04).
 *
 * Two layers. "Needs you now" is a ranked queue derived from every widget - the things
 * that are late, waiting on this person, or about to start - so the first screen answers
 * "what should I do" rather than "what are the numbers". Below it, the widgets the person
 * has chosen, in the order they chose.
 *
 * Each widget loads independently and degrades on its own, so one unavailable service
 * cannot blank the page. Every widget is scoped to the caller on the server.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlarmClock, ArrowDown, LifeBuoy, ArrowUp, CalendarDays, CheckSquare, Clock, Handshake, HardDrive,
  Megaphone, ReceiptText, RotateCcw, ShieldCheck, SlidersHorizontal, X,
} from 'lucide-react';
import { DateTimeCard } from './Attendance';
import { api, ApiError, type Widget } from '../lib/api';
import { TaskPriority } from '../components/TaskPriority';
import { SignatureRequests } from '../components/SignatureRequests';
import { useQuery } from '../lib/query';
import { Loading, ErrorState } from '../components/States';
import { useSession } from '../lib/session';
import { useAttendance, formatMinutes } from '../lib/attendance';
import { formatBytes, formatTime, relativeTime, titleCase } from '../lib/format';
import '../styles/command.css';

type Meeting = { id: string; title: string; starts_at: string; ends_at: string; timezone: string; has_video: boolean; rsvp: string };
type Task = { id: string; title: string; status: string; priority: string; due_at: string | null; project_key: string; number: number };

type Dashboard = {
  meetings: Widget<Meeting[]>;
  tasks: Widget<Task[]>;
  approvals: Widget<{ awaiting: number; mine_pending: number }>;
  notifications: Widget<{ unread: number }>;
  announcements: Widget<
    { id: string; title: string; body: string; priority: string; publish_at: string; author_name: string | null }[]
  >;
  storage: Widget<{ usedBytes: number; fileCount: number }>;
  work: Widget<{ openTasks: number; dueSoon: number; overdue: number; doneThisWeek: number; completionRate: number | null }>;
  attendance: Widget<{ minimumMinutes: number; todayMinutes: number; weekMinutes: number; daysMetMinimum: number; workingDaysRecorded: number }>;
  clients?: Widget<{
    uploads: { id: string; org_id: string; org_name: string; file_name: string; kind: string; created_at: string }[];
    invoices: { overdue: number; outstanding: number } | null;
  }>;
  service?: Widget<{
    assigned: number; unassigned: number; breached: number; mineBreached: number;
    tickets: { id: string; ref: string; subject: string; priority: string; status: string; breached: boolean; mine: boolean }[];
  }>;
};

type WidgetId = 'schedule' | 'tasks' | 'service' | 'approvals' | 'attendance' | 'clients' | 'announcements' | 'storage';

const WIDGET_LABELS: Record<WidgetId, string> = {
  schedule: 'Schedule',
  tasks: 'My work',
  service: 'Support tickets',
  approvals: 'Approvals',
  attendance: 'Attendance',
  clients: 'Client activity',
  announcements: 'Announcements',
  storage: 'Storage',
};
const DEFAULT_ORDER: WidgetId[] = ['schedule', 'tasks', 'service', 'approvals', 'attendance', 'clients', 'announcements', 'storage'];

type Layout = { order: WidgetId[]; hidden: WidgetId[] };

function readLayout(key: string): Layout {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { order: DEFAULT_ORDER, hidden: [] };
    const parsed = JSON.parse(raw) as Layout;
    const known = parsed.order.filter((id) => DEFAULT_ORDER.includes(id));
    // Widgets added after the layout was saved go at the end rather than disappearing.
    return { order: [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))], hidden: parsed.hidden ?? [] };
  } catch {
    return { order: DEFAULT_ORDER, hidden: [] };
  }
}

/** Renders a widget's own unavailable state rather than failing the whole page. */
function WidgetBody<T>({ widget, children }: { widget: Widget<T>; children: (data: T) => React.ReactNode }) {
  if (widget.state === 'unavailable') {
    return <p className="widget-unavailable" role="status">{widget.reason}</p>;
  }
  return <>{children(widget.data)}</>;
}

type Priority = { id: string; tone: 'critical' | 'warning' | 'info'; icon: React.ReactNode; title: string; detail?: string; to?: string; action?: React.ReactNode };

export default function Command() {
  const { session, can } = useSession();
  const attendance = useAttendance();
  const [customising, setCustomising] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const [clocking, setClocking] = useState(false);
  const layoutKey = `infinity:command:${session?.user?.id ?? 'anonymous'}:layout`;
  const [layout, setLayoutState] = useState<Layout>(() => readLayout(layoutKey));
  const setLayout = (next: Layout) => {
    setLayoutState(next);
    try { window.localStorage.setItem(layoutKey, JSON.stringify(next)); } catch { /* best effort */ }
  };

  const dashboard = useQuery<Dashboard>('/me/dashboard', (signal) => api.get('/me/dashboard', signal), {
    ttlMs: 15_000,
  });
  const data = dashboard.data;

  /** Which widgets this role can have at all; customisation only reorders within these. */
  const available = useMemo(() => {
    const set = new Set<WidgetId>(['schedule', 'tasks', 'approvals', 'announcements']);
    if (can('attendance.record')) set.add('attendance');
    if (data?.clients) set.add('clients');
    if (data?.service) set.add('service');
    if (can('settings.read')) set.add('storage');
    return set;
  }, [can, data?.clients, data?.service]);

  const priorities = useMemo<Priority[]>(() => {
    if (!data) return [];
    const out: Priority[] = [];
    const now = Date.now();
    if (data.approvals.state === 'ok' && data.approvals.data.awaiting > 0) {
      const n = data.approvals.data.awaiting;
      out.push({ id: 'approvals', tone: 'critical', icon: <ShieldCheck size={16} />, to: '/approvals',
        title: `${n} ${n === 1 ? 'request is' : 'requests are'} waiting for your decision` });
    }
    if (data.service?.state === 'ok' && data.service.data.mineBreached > 0) {
      const n = data.service.data.mineBreached;
      out.push({ id: 'tickets-breached', tone: 'critical', icon: <LifeBuoy size={16} />, to: '/service?view=breached',
        title: `${n} of your ${n === 1 ? 'ticket has' : 'tickets have'} missed a service-level target` });
    }
    if (data.service?.state === 'ok' && data.service.data.unassigned > 0) {
      const n = data.service.data.unassigned;
      out.push({ id: 'tickets-unassigned', tone: 'warning', icon: <LifeBuoy size={16} />, to: '/service?view=unassigned',
        title: `${n} ${n === 1 ? 'ticket is' : 'tickets are'} waiting for someone to pick ${n === 1 ? 'it' : 'them'} up` });
    }
    if (data.work.state === 'ok' && data.work.data.overdue > 0) {
      const n = data.work.data.overdue;
      out.push({ id: 'overdue', tone: 'critical', icon: <AlarmClock size={16} />, to: '/tasks',
        title: `${n} overdue ${n === 1 ? 'task' : 'tasks'}`, detail: 'Past their due date and still open' });
    }
    if (data.meetings.state === 'ok') {
      for (const m of data.meetings.data) {
        const startsIn = (new Date(m.starts_at).getTime() - now) / 60_000;
        if (startsIn <= 60 && new Date(m.ends_at).getTime() > now) {
          out.push({ id: `soon:${m.id}`, tone: 'warning', icon: <CalendarDays size={16} />, to: `/meetings/${m.id}`,
            title: startsIn <= 0 ? `${m.title} is happening now` : `${m.title} starts ${relativeTime(m.starts_at)}`,
            detail: m.has_video ? 'Video meeting' : 'In person' });
        } else if (m.rsvp === 'needs_action') {
          out.push({ id: `rsvp:${m.id}`, tone: 'info', icon: <CalendarDays size={16} />, to: `/meetings/${m.id}`,
            title: `Respond to “${m.title}”`, detail: `Starts ${formatTime(m.starts_at)}` });
        }
      }
    }
    if (data.clients?.state === 'ok' && (data.clients.data.invoices?.overdue ?? 0) > 0) {
      const n = data.clients.data.invoices!.overdue;
      out.push({ id: 'invoices', tone: 'warning', icon: <ReceiptText size={16} />, to: '/finance',
        title: `${n} overdue client ${n === 1 ? 'invoice' : 'invoices'}` });
    }
    const weekday = new Date().getDay();
    if (can('attendance.record') && !attendance.loading && !attendance.open && weekday !== 0 && weekday !== 6
      && (attendance.today?.minutes ?? 0) === 0) {
      out.push({ id: 'clock', tone: 'info', icon: <Clock size={16} />, title: 'You have not clocked in today',
        action: (
          <button type="button" className="primary-button cc-inline-action" disabled={clocking}
            onClick={async () => {
              setClocking(true); setClockError(null);
              try { await attendance.clockIn(); dashboard.reload(); }
              catch (err) { setClockError(err instanceof ApiError ? err.message : 'Could not clock in'); }
              finally { setClocking(false); }
            }}>
            {clocking ? 'Clocking in…' : 'Clock in'}
          </button>
        ) });
    }
    return out;
  }, [data, can, attendance, clocking, dashboard]);

  if (dashboard.loading && !data) return <Loading label="Loading your command centre" rows={5} />;
  if (dashboard.error && !data) return <ErrorState error={dashboard.error} onRetry={dashboard.reload} />;
  if (!data) return <Loading />;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = session?.user?.displayName.split(' ')[0] ?? '';
  const visible = layout.order.filter((id) => available.has(id) && !layout.hidden.includes(id));

  const move = (id: WidgetId, delta: number) => {
    const order = [...layout.order];
    const from = order.indexOf(id);
    // Step over widgets this role cannot see, so a move is always visible.
    let to = from + delta;
    while (to >= 0 && to < order.length && !available.has(order[to])) to += delta;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    setLayout({ ...layout, order });
  };

  const widgets: Record<WidgetId, () => React.ReactNode> = {
    schedule: () => (
      <CcPanel id="schedule" icon={<CalendarDays size={15} />} title="Schedule · next 24 hours" link={{ to: '/meetings', label: 'Calendar' }}>
        <WidgetBody widget={data.meetings}>
          {(meetings) => meetings.length === 0 ? <p className="cc-empty">Nothing scheduled. A clear day.</p> : (
            <ul className="cc-rows">
              {meetings.map((m) => (
                <li key={m.id}>
                  <Link to={`/meetings/${m.id}`} className="cc-row">
                    <time className="cc-time" dateTime={m.starts_at}>{formatTime(m.starts_at)}</time>
                    <span className="cc-row-main">
                      <strong>{m.title}</strong>
                      <span>{m.has_video ? 'Video meeting' : 'In person'}</span>
                    </span>
                    {m.rsvp === 'needs_action' ? <span className="cc-tag cc-tag-info">Reply needed</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </WidgetBody>
      </CcPanel>
    ),
    tasks: () => (
      <CcPanel id="tasks" icon={<CheckSquare size={15} />} title="My work" link={{ to: '/tasks', label: 'Board' }}>
        <WidgetBody widget={data.work}>
          {(work) => (
            <dl className="cc-stats">
              <div><dt>Open</dt><dd>{work.openTasks}</dd></div>
              <div className={work.overdue > 0 ? 'is-critical' : ''}><dt>Overdue</dt><dd>{work.overdue}</dd></div>
              <div><dt>Due in 7 days</dt><dd>{work.dueSoon}</dd></div>
              <div><dt>Done this week</dt><dd>{work.doneThisWeek}</dd></div>
            </dl>
          )}
        </WidgetBody>
        <WidgetBody widget={data.tasks}>
          {(tasks) => tasks.length === 0 ? <p className="cc-empty">No open tasks assigned to you.</p> : (
            <ul className="cc-rows">
              {tasks.map((t) => {
                const late = t.due_at && new Date(t.due_at).getTime() < Date.now();
                return (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="cc-row">
                      <TaskPriority priority={t.priority} />
                      <span className="cc-row-main">
                        <strong>{t.title}</strong>
                        <span>{t.project_key}-{t.number} · {titleCase(t.status)}</span>
                      </span>
                      {t.due_at ? <span className={`cc-tag ${late ? 'cc-tag-critical' : ''}`}>{late ? 'Overdue' : `Due ${relativeTime(t.due_at)}`}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </WidgetBody>
      </CcPanel>
    ),
    service: () => data.service ? (
      <CcPanel id="service" icon={<LifeBuoy size={15} />} title="Support tickets" link={{ to: '/service', label: 'Service desk' }}>
        <WidgetBody widget={data.service}>
          {(sv) => (
            <>
              <dl className="cc-stats cc-stats-3">
                <div><dt>Assigned to me</dt><dd>{sv.assigned}</dd></div>
                <div className={sv.unassigned > 0 ? 'is-critical' : ''}><dt>Unassigned</dt><dd>{sv.unassigned}</dd></div>
                <div className={sv.breached > 0 ? 'is-critical' : ''}><dt>SLA breached</dt><dd>{sv.breached}</dd></div>
              </dl>
              {sv.tickets.length === 0 ? <p className="cc-empty">No open tickets for you or waiting to be picked up.</p> : (
                <ul className="cc-rows">
                  {sv.tickets.map((t) => (
                    <li key={t.id}>
                      <Link to={`/service/tickets/${t.id}`} className="cc-row">
                        <span className="cc-row-main">
                          <strong>{t.ref} · {t.subject}</strong>
                          <span>{titleCase(t.priority)} priority · {t.mine ? 'Assigned to you' : 'Unassigned'}</span>
                        </span>
                        {t.breached ? <span className="cc-tag cc-tag-critical">Breached</span> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </WidgetBody>
      </CcPanel>
    ) : null,
    approvals: () => (
      <CcPanel id="approvals" icon={<ShieldCheck size={15} />} title="Approvals" link={{ to: '/approvals', label: 'Open' }}>
        <WidgetBody widget={data.approvals}>
          {(a) => (
            <dl className="cc-stats cc-stats-2">
              <div className={a.awaiting > 0 ? 'is-critical' : ''}><dt>Awaiting your decision</dt><dd>{a.awaiting}</dd></div>
              <div><dt>Your pending requests</dt><dd>{a.mine_pending}</dd></div>
            </dl>
          )}
        </WidgetBody>
      </CcPanel>
    ),
    attendance: () => (
      <CcPanel id="attendance" icon={<Clock size={15} />} title="Attendance" link={{ to: '/attendance', label: 'Timesheet' }}>
        <p className="cc-status-line">
          <span className={`cc-dot ${attendance.open ? 'is-ok' : ''}`} aria-hidden="true" />
          {attendance.open ? 'Clocked in' : 'Not clocked in'}
        </p>
        <WidgetBody widget={data.attendance}>
          {(at) => (
            <dl className="cc-stats cc-stats-3">
              <div className={at.todayMinutes >= at.minimumMinutes ? 'is-ok' : ''}>
                <dt>Today</dt><dd>{formatMinutes(at.todayMinutes)}</dd>
              </div>
              <div><dt>Last 7 days</dt><dd>{formatMinutes(at.weekMinutes)}</dd></div>
              <div><dt>Days at minimum</dt><dd>{at.daysMetMinimum}/{at.workingDaysRecorded}</dd></div>
            </dl>
          )}
        </WidgetBody>
      </CcPanel>
    ),
    clients: () => data.clients ? (
      <CcPanel id="clients" icon={<Handshake size={15} />} title="Client activity" link={{ to: '/clients', label: 'Clients' }}>
        <WidgetBody widget={data.clients}>
          {(c) => (
            <>
              {c.invoices ? (
                <dl className="cc-stats cc-stats-2">
                  <div className={c.invoices.overdue > 0 ? 'is-critical' : ''}><dt>Overdue invoices</dt><dd>{c.invoices.overdue}</dd></div>
                  <div><dt>Outstanding invoices</dt><dd>{c.invoices.outstanding}</dd></div>
                </dl>
              ) : null}
              {c.uploads.length === 0 ? <p className="cc-empty">No client uploads in the last two weeks.</p> : (
                <ul className="cc-rows">
                  {c.uploads.map((u) => (
                    <li key={u.id}>
                      <Link to={`/clients/${u.org_id}`} className="cc-row">
                        <span className="cc-row-main">
                          <strong>{u.org_name}</strong>
                          <span>Uploaded {u.file_name}</span>
                        </span>
                        <time className="cc-meta" dateTime={u.created_at}>{relativeTime(u.created_at)}</time>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </WidgetBody>
      </CcPanel>
    ) : null,
    announcements: () => (
      <CcPanel id="announcements" icon={<Megaphone size={15} />} title="Announcements" link={{ to: '/announcements', label: 'All' }}>
        <WidgetBody widget={data.announcements}>
          {(items) => items.length === 0 ? <p className="cc-empty">No current announcements.</p> : (
            <ul className="cc-rows">
              {items.map((a) => (
                <li key={a.id}>
                  <Link to={`/announcements/${a.id}`} className="cc-row">
                    <span className="cc-row-main">
                      <strong>{a.title}</strong>
                      <span>{a.author_name ?? 'Workspace'} · {relativeTime(a.publish_at)}</span>
                    </span>
                    {a.priority !== 'normal' ? <span className={`cc-tag ${a.priority === 'urgent' || a.priority === 'critical' ? 'cc-tag-critical' : 'cc-tag-info'}`}>{titleCase(a.priority)}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </WidgetBody>
      </CcPanel>
    ),
    storage: () => (
      <CcPanel id="storage" icon={<HardDrive size={15} />} title="Company storage" link={{ to: '/files', label: 'Files' }}>
        <WidgetBody widget={data.storage}>
          {(s) => (
            <dl className="cc-stats cc-stats-2">
              <div><dt>Used</dt><dd>{formatBytes(s.usedBytes)}</dd></div>
              <div><dt>Files</dt><dd>{s.fileCount}</dd></div>
            </dl>
          )}
        </WidgetBody>
      </CcPanel>
    ),
  };

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div>
          <p className="cc-eyebrow">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h2>{greeting}{firstName ? `, ${firstName}` : ''}</h2>
        </div>
        <div className="cc-header-side">
          <DateTimeCard />
          <button type="button" className="ghost-button" aria-expanded={customising} aria-controls="cc-customise"
            onClick={() => setCustomising((c) => !c)}>
            <SlidersHorizontal size={15} aria-hidden="true" /> Customise
          </button>
        </div>
      </header>

      {customising ? (
        <section className="cc-customise" id="cc-customise" aria-label="Customise command centre">
          <header>
            <h3>Sections</h3>
            <div>
              <button type="button" className="ghost-button" onClick={() => setLayout({ order: DEFAULT_ORDER, hidden: [] })}>
                <RotateCcw size={14} aria-hidden="true" /> Reset
              </button>
              <button type="button" className="icon-button" aria-label="Close customisation" onClick={() => setCustomising(false)}>
                <X size={16} />
              </button>
            </div>
          </header>
          <ul>
            {layout.order.filter((id) => available.has(id)).map((id, index, list) => {
              const shown = !layout.hidden.includes(id);
              return (
                <li key={id}>
                  <label>
                    <input type="checkbox" checked={shown}
                      onChange={() => setLayout({ ...layout, hidden: shown ? [...layout.hidden, id] : layout.hidden.filter((h) => h !== id) })} />
                    {WIDGET_LABELS[id]}
                  </label>
                  <button type="button" className="icon-button" disabled={index === 0}
                    aria-label={`Move ${WIDGET_LABELS[id]} up`} onClick={() => move(id, -1)}><ArrowUp size={14} /></button>
                  <button type="button" className="icon-button" disabled={index === list.length - 1}
                    aria-label={`Move ${WIDGET_LABELS[id]} down`} onClick={() => move(id, 1)}><ArrowDown size={14} /></button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <SignatureRequests />

      <section className="cc-priorities" aria-labelledby="cc-priorities-heading">
        <header>
          <h3 id="cc-priorities-heading">Needs you now</h3>
          {data.notifications.state === 'ok' && data.notifications.data.unread > 0 ? (
            <span className="cc-meta">{data.notifications.data.unread} unread notifications</span>
          ) : null}
        </header>
        {clockError ? <p className="field-error" role="alert">{clockError}</p> : null}
        {priorities.length === 0 ? (
          <p className="cc-clear">Nothing is waiting on you. Late tasks, decisions and meetings that are about to start will show up here.</p>
        ) : (
          <ol>
            {priorities.map((p) => (
              <li key={p.id} className={`cc-priority is-${p.tone}`}>
                <span className="cc-priority-icon" aria-hidden="true">{p.icon}</span>
                {p.to ? (
                  <Link to={p.to} className="cc-priority-main">
                    <strong>{p.title}</strong>
                    {p.detail ? <span>{p.detail}</span> : null}
                  </Link>
                ) : (
                  <span className="cc-priority-main"><strong>{p.title}</strong>{p.detail ? <span>{p.detail}</span> : null}</span>
                )}
                {p.action}
              </li>
            ))}
          </ol>
        )}
      </section>

      {visible.length === 0 ? (
        <p className="cc-clear">All sections are hidden. Use Customise to bring them back.</p>
      ) : (
        <div className="cc-grid">
          {visible.map((id) => <div key={id} className={`cc-cell cc-cell-${id}`}>{widgets[id]()}</div>)}
        </div>
      )}
    </div>
  );
}

function CcPanel({ id, icon, title, link, children }: {
  id: string; icon: React.ReactNode; title: string; link: { to: string; label: string }; children: React.ReactNode;
}) {
  return (
    <section className="cc-panel" aria-labelledby={`cc-${id}-heading`}>
      <header>
        <span aria-hidden="true">{icon}</span>
        <h3 id={`cc-${id}-heading`}>{title}</h3>
        <Link to={link.to} className="cc-panel-link">{link.label}</Link>
      </header>
      <div className="cc-panel-body">{children}</div>
    </section>
  );
}
