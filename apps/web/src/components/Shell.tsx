/**
 * Application shell (blueprint 16): persistent navigation, current module title, global
 * search, notifications and account controls.
 *
 * Landmarks, a skip link and a live region are built in so keyboard and screen-reader
 * users get the same structure as everyone else.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  CalendarDays,
  CheckSquare,
  Files as FilesIcon,
  Inbox,
  Megaphone,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  Search as SearchIcon,
  Settings as SettingsIcon,
  ShieldCheck,
  Users,
  Handshake,
  Palmtree,
  BookText,
  Wallet,
  Target,
  BarChart3,
  X,
} from 'lucide-react';
import { useSession } from '../lib/session';
import { desktop, isDesktop } from '../lib/desktop';
import { UpdateBanner } from './UpdateBanner';
import { api, type Notification, type Paged } from '../lib/api';
import { useQuery, invalidate, clearCache } from '../lib/query';
import { realtime, type ConnectionState } from '../lib/realtime';
import { initials, relativeTime } from '../lib/format';
import { Logo } from './Logo';
import { inQuietHours, useNotify } from '../lib/notify';

type NavItem = {
  to: string;
  label: string;
  icon: typeof Inbox;
  /** Hides the entry when the role cannot use it; the API still enforces access. */
  capability?: string;
};

const NAV_ITEMS: NavItem[] = [
  { to: '/command', label: 'Command', icon: LayoutDashboard },
  { to: '/meetings', label: 'Meetings', icon: CalendarDays, capability: 'calendar.read' },
  { to: '/chat', label: 'Chat', icon: MessageSquareText, capability: 'room.join' },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare, capability: 'task.update' },
  { to: '/files', label: 'Files', icon: FilesIcon, capability: 'file.read' },
  { to: '/docs', label: 'Documents', icon: BookText, capability: 'doc.read' },
  { to: '/announcements', label: 'Announcements', icon: Megaphone },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck, capability: 'request.create' },
  { to: '/leave', label: 'Leave', icon: Palmtree, capability: 'leave.request' },
  { to: '/finance', label: 'Finance', icon: Wallet, capability: 'expense.submit' },
  { to: '/growth', label: 'Growth', icon: Target, capability: 'goal.manage' },
  { to: '/people', label: 'People', icon: Users, capability: 'user.read' },
  { to: '/clients', label: 'Clients', icon: Handshake, capability: 'external_org.read' },
  { to: '/reports', label: 'Reports', icon: BarChart3, capability: 'report.read' },
  { to: '/admin', label: 'Admin', icon: SettingsIcon, capability: 'settings.read' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { session, can, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { notify, preferences, setBadgeCount } = useNotify();
  /**
   * The realtime subscription is opened once per session. Reading notify and
   * preferences through a ref keeps them current inside that long-lived closure
   * without making the socket depend on them - re-subscribing on a preference change
   * would drop and re-open the connection for no reason.
   */
  const notifyRef = useRef(notify);
  const prefsRef = useRef(preferences);
  useEffect(() => { notifyRef.current = notify; }, [notify]);
  useEffect(() => { prefsRef.current = preferences; }, [preferences]);
  const [navOpen, setNavOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const searchRef = useRef<HTMLInputElement>(null);

  const user = session?.user;

  // One realtime connection for the whole session, torn down on sign-out.
  useEffect(() => {
    realtime.connect();
    const offState = realtime.onStateChange(setConnection);
    const offFrame = realtime.on((frame) => {
      // Reconcile rather than trust: the frame tells us what changed, then the cache
      // refetches the authoritative record.
      if (frame.type === 'notification.created') {
        invalidate('/me/notifications');

        const payload = frame.data as {
          title?: string; body?: string; link?: string; severity?: string;
        };
        /**
         * Severity decides how loud this gets. Anything the server did not classify is
         * information, not an alarm - defaulting the other way trains people to ignore
         * the banner that actually matters.
         */
        const severity =
          payload.severity === 'critical' || payload.severity === 'warning'
            || payload.severity === 'success'
            ? payload.severity
            : 'info';

        if (prefsRef.current.bannersEnabled) {
          notifyRef.current({
            severity,
            title: payload.title ?? 'Infinity Workspace',
            body: payload.body,
            link: payload.link,
          });
        }
        /**
         * On the desktop a notification should reach someone who is not looking at the
         * window - that is most of the point of leaving the browser. The payload carries
         * its own route, and the main process validates it before navigating, so a
         * notification cannot be used to send the window somewhere unexpected.
         */
        // Quiet hours suppress the OS banner but never the record itself: the
        // notification is still in the panel and still counted as unread.
        if (isDesktop && prefsRef.current.bannersEnabled && !inQuietHours(prefsRef.current)) {
          void desktop?.notify({
            title: payload.title ?? 'Infinity Workspace',
            body: payload.body ?? '',
            deepLink: payload.link,
          });
        }
      }
      if (frame.type.startsWith('message.')) invalidate('/chat');
      if (frame.type.startsWith('task.')) invalidate('/tasks');
      if (frame.type === 'session.revoked') void signOut();
    });
    return () => {
      offState();
      offFrame();
      realtime.disconnect();
    };
  }, [signOut]);

  // Close the mobile navigation whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
    setNotificationsOpen(false);
  }, [location.pathname]);

  // "/" focuses search, the convention people already expect.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA'].includes(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const notifications = useQuery<Paged<Notification>>('/me/notifications?limit=15', (signal) =>
    api.get('/me/notifications?limit=15', signal),
  );
  const unread = (notifications.data?.items ?? []).filter((n) => !n.read_at).length;

  // The dock or taskbar badge is the only signal someone gets with the window closed.
  useEffect(() => {
    if (isDesktop) void desktop?.setBadge(unread);
    // The web build has no dock, so the count goes in the tab title instead.
    setBadgeCount(unread);
  }, [unread, setBadgeCount]);

  /**
   * A notification click asks the main process to bring the window forward and hands the
   * route back here. Listening on the window keeps the preload free of any knowledge of
   * the router.
   */
  useEffect(() => {
    if (!isDesktop) return;
    const handler = (event: Event) => {
      const route = (event as CustomEvent<string>).detail;
      if (typeof route === 'string') navigate(route);
    };
    window.addEventListener('infinity:navigate', handler);
    return () => window.removeEventListener('infinity:navigate', handler);
  }, [navigate]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    clearCache();
    navigate('/sign-in', { replace: true });
  }, [navigate, signOut]);

  const onSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('q');
    if (typeof value === 'string' && value.trim().length > 1) {
      navigate(`/search?q=${encodeURIComponent(value.trim())}`);
    }
  };

  const currentModule =
    NAV_ITEMS.find((item) => location.pathname.startsWith(item.to))?.label ?? 'Workspace';

  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <nav
        className={`sidebar ${navOpen ? 'sidebar-open' : ''}`}
        aria-label="Modules"
        id="module-navigation"
      >
        <div className="brand-lockup">
          <Logo size={34} tone="inverse" />
          <div>
            <strong>Infinity Workspace</strong>
            <span>{session?.company?.name ?? 'Workspace'}</span>
          </div>
        </div>

        <ul className="nav-list">
          {NAV_ITEMS.filter((item) => !item.capability || can(item.capability)).map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
              >
                <item.icon size={17} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="sidebar-footer">
          <div className="security-panel">
            <ShieldCheck size={16} aria-hidden="true" />
            <div>
              <strong>{session?.company?.name ?? 'Workspace'}</strong>
              <span>{session?.user?.email ?? ''}</span>
            </div>
          </div>
          <p className={`connection-pill connection-${connection}`}>
            <span aria-hidden="true" className="connection-dot" />
            {connection === 'open'
              ? 'Live'
              : connection === 'reconnecting'
                ? 'Reconnecting…'
                : connection === 'connecting'
                  ? 'Connecting…'
                  : 'Offline'}
          </p>
        </div>
      </nav>

      {navOpen ? (
        <button
          type="button"
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <div className="workspace-main">
        <header className="top-bar">
          <button
            type="button"
            className="icon-button nav-toggle"
            aria-expanded={navOpen}
            aria-controls="module-navigation"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setNavOpen((open) => !open)}
          >
            {navOpen ? <X size={18} /> : <Menu size={18} />}
          </button>

          <h1 className="page-title">{currentModule}</h1>

          <form className="global-search" role="search" onSubmit={onSearch}>
            <label className="visually-hidden" htmlFor="global-search-input">
              Search the workspace
            </label>
            <SearchIcon size={16} aria-hidden="true" />
            <input
              id="global-search-input"
              ref={searchRef}
              name="q"
              type="search"
              placeholder="Search files, people, tasks…  ( / )"
              autoComplete="off"
            />
          </form>

          <div className="top-bar-actions">
            <button
              type="button"
              className="icon-button"
              aria-expanded={notificationsOpen}
              aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <Bell size={18} />
              {unread > 0 ? <span className="badge">{unread > 99 ? '99+' : unread}</span> : null}
            </button>

            <Link to="/settings" className="account-chip">
              <span className="avatar" style={{ background: user?.avatarColor ?? '#f2c14e' }}>
                {initials(user?.displayName ?? '?')}
              </span>
              <span className="account-name">{user?.displayName}</span>
            </Link>

            <button type="button" className="icon-button" onClick={handleSignOut} aria-label="Sign out">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {notificationsOpen ? (
          <NotificationPanel
            notifications={notifications.data?.items ?? []}
            onClose={() => setNotificationsOpen(false)}
          />
        ) : null}

        <main id="main-content" className="workspace-content" tabIndex={-1}>
          <UpdateBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

function NotificationPanel({
  notifications,
  onClose,
}: {
  notifications: Notification[];
  onClose: () => void;
}) {
  const markAllRead = async () => {
    await api.post('/me/notifications/read-all');
    invalidate('/me/notifications');
  };

  return (
    <section className="notification-panel" aria-label="Notifications">
      <header>
        <h2>Notifications</h2>
        <div>
          <button type="button" className="ghost-button" onClick={markAllRead}>
            Mark all read
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close notifications">
            <X size={16} />
          </button>
        </div>
      </header>
      {notifications.length === 0 ? (
        <p className="notification-empty">You are all caught up.</p>
      ) : (
        <ul>
          {notifications.map((notification) => (
            <li key={notification.id} className={notification.read_at ? '' : 'notification-unread'}>
              <Link
                to={notification.link ?? '/command'}
                onClick={async () => {
                  await api.post(`/me/notifications/${notification.id}/read`).catch(() => undefined);
                  invalidate('/me/notifications');
                  onClose();
                }}
              >
                <strong>{notification.title}</strong>
                {notification.body ? <span>{notification.body}</span> : null}
                <time dateTime={notification.created_at}>{relativeTime(notification.created_at)}</time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
