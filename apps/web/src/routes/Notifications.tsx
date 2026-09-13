/**
 * Notification centre.
 *
 * The bell panel shows the latest fifteen; this is the whole history, filterable by
 * unread and by kind, grouped by day, paged with the server's cursor. Reading and
 * clearing are the same two acts as in the panel and go through the same endpoints, and
 * the realtime map invalidates '/me/notifications' so both views stay in step.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck, Trash2, X } from 'lucide-react';
import { api, type Notification, type Paged } from '../lib/api';
import { invalidate, useQuery } from '../lib/query';
import { Empty, ErrorState, Loading } from '../components/States';
import { formatDate, formatTime } from '../lib/format';
import '../styles/command.css';

/** Groups of server notification types, so filters speak the reader's language. */
const KINDS: { id: string; label: string; match: (type: string) => boolean }[] = [
  { id: 'all', label: 'Everything', match: () => true },
  { id: 'work', label: 'Work', match: (t) => t.startsWith('task') || t.startsWith('share') || t.startsWith('file') },
  { id: 'approvals', label: 'Approvals & signatures', match: (t) => t.startsWith('approval') || t.startsWith('signature') },
  { id: 'meetings', label: 'Meetings', match: (t) => t.startsWith('meeting') || t.startsWith('event') },
  { id: 'messages', label: 'Messages & announcements', match: (t) => t === 'message' || t === 'announcement' },
  { id: 'clients', label: 'Clients', match: (t) => t.startsWith('portal') },
  { id: 'attendance', label: 'Attendance', match: (t) => t.startsWith('attendance') },
];

export default function Notifications() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [kind, setKind] = useState('all');
  const [pages, setPages] = useState<Notification[][]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // `unreadOnly` is only sent when true: the server coerces any present value to true.
  const firstKey = `/me/notifications?limit=50${unreadOnly ? '&unreadOnly=true' : ''}`;
  const first = useQuery<Paged<Notification>>(firstKey, (signal) => api.get(firstKey, signal));

  // A refetch of the first page (realtime, or after an action) resets the older pages.
  useEffect(() => {
    setPages([]);
    setCursor(first.data?.nextCursor ?? null);
  }, [first.data]);

  const all = useMemo(() => [...(first.data?.items ?? []), ...pages.flat()], [first.data, pages]);
  const matcher = KINDS.find((k) => k.id === kind)!.match;
  const visible = all.filter((n) => matcher(n.type));

  const groups = useMemo(() => {
    const out: { day: string; items: Notification[] }[] = [];
    for (const n of visible) {
      const day = formatDate(n.created_at);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(n);
    }
    return out;
  }, [visible]);

  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch {
      setActionError('That did not go through. Check your connection and try again.');
    }
    invalidate('/me/notifications');
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await api.get<Paged<Notification>>(
        `/me/notifications?limit=50&cursor=${encodeURIComponent(cursor)}${unreadOnly ? '&unreadOnly=true' : ''}`,
      );
      setPages((p) => [...p, next.items]);
      setCursor(next.nextCursor);
    } catch {
      setActionError('Older notifications could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  const unreadCount = all.filter((n) => !n.read_at).length;

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div>
          <p className="cc-eyebrow">Communication</p>
          <h2>Notifications</h2>
        </div>
        <div className="cc-header-side">
          <button type="button" className="ghost-button" disabled={unreadCount === 0}
            onClick={() => run(() => api.post('/me/notifications/read-all'))}>
            <CheckCheck size={15} aria-hidden="true" /> Mark all read
          </button>
          <button type="button" className="ghost-button" disabled={all.length === 0}
            onClick={() => run(() => api.delete('/me/notifications'))}>
            <Trash2 size={15} aria-hidden="true" /> Clear all
          </button>
        </div>
      </header>

      <div className="nc-filters" role="group" aria-label="Filter notifications">
        <div className="tab-row">
          <button type="button" className={`tab ${!unreadOnly ? 'tab-active' : ''}`} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All</button>
          <button type="button" className={`tab ${unreadOnly ? 'tab-active' : ''}`} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Unread</button>
        </div>
        <label className="nc-kind">
          <span className="visually-hidden">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>
      </div>

      {actionError ? <p className="field-error" role="alert">{actionError}</p> : null}

      {first.loading && !first.data ? <Loading label="Loading notifications" rows={6} />
        : first.error && !first.data ? <ErrorState error={first.error} onRetry={first.reload} />
        : visible.length === 0 ? (
          <Empty icon={<Bell size={22} />}
            title={unreadOnly ? 'No unread notifications' : 'No notifications'}
            description={kind !== 'all' ? 'Nothing of this kind. Try another filter.' : 'Assignments, approvals, meetings and client activity will appear here.'} />
        ) : (
          <div className="nc-list">
            {groups.map((g) => (
              <section key={g.day} className="cc-panel" aria-label={g.day}>
                <header><h3>{g.day}</h3></header>
                <ul className="cc-rows">
                  {g.items.map((n) => (
                    <li key={n.id} className={`nc-item ${n.read_at ? '' : 'is-unread'}`}>
                      <span className="nc-dot" aria-hidden="true" />
                      {n.link ? (
                        <Link to={n.link} className="cc-row nc-main"
                          onClick={() => { if (!n.read_at) void run(() => api.post(`/me/notifications/${n.id}/read`)); }}>
                          <NotificationText n={n} />
                        </Link>
                      ) : (
                        <div className="cc-row nc-main"><NotificationText n={n} /></div>
                      )}
                      {!n.read_at ? (
                        <button type="button" className="icon-button" aria-label={`Mark read: ${n.title}`} title="Mark read"
                          onClick={() => run(() => api.post(`/me/notifications/${n.id}/read`))}>
                          <CheckCheck size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                      <button type="button" className="icon-button" aria-label={`Clear: ${n.title}`} title="Clear"
                        onClick={() => run(() => api.delete(`/me/notifications/${n.id}`))}>
                        <X size={14} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {cursor ? (
              <button type="button" className="ghost-button nc-more" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading…' : 'Load older notifications'}
              </button>
            ) : null}
          </div>
        )}
    </div>
  );
}

function NotificationText({ n }: { n: Notification }) {
  return (
    <>
      <span className="cc-row-main">
        <strong>{n.title}</strong>
        {n.body ? <span>{n.body}</span> : null}
      </span>
      <time className="cc-meta" dateTime={n.created_at}>{formatTime(n.created_at)}</time>
    </>
  );
}
