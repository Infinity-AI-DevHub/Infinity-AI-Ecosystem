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
  ChevronRight,
  Mail,
  ExternalLink,
  Clock3,
  Command as CommandIcon,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search as SearchIcon,
  Star,
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
import { keysForEvent } from '../lib/realtime-map';
import { allowed, findModule, locate, visibleAreas, type NavArea } from '../lib/navigation';
import { useNavPreferences } from '../lib/nav-preferences';
import { CommandPalette } from './CommandPalette';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const searchRef = useRef<HTMLInputElement>(null);

  const user = session?.user;
  const prefs = useNavPreferences(user?.id);
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed, recordVisit } = prefs;
  const areas = visibleAreas(can);
  const located = locate(location.pathname);
  /**
   * The rail can preview another area without navigating; the sidebar then shows that
   * area until the route changes, at which point it follows the page again.
   */
  const [previewArea, setPreviewArea] = useState<string | null>(null);
  const activeAreaId = previewArea ?? located?.area.id ?? areas[0]?.id;
  const activeArea: NavArea | undefined = areas.find((a) => a.id === activeAreaId) ?? areas[0];

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
      /**
       * Everything else refreshes silently. The frame says what changed; the cache
       * refetches the authoritative record rather than trusting the payload, and the
       * person sees the screen become correct without being interrupted about it.
       */
      for (const key of keysForEvent(frame.type)) invalidate(key);

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
    setPreviewArea(null);
  }, [location.pathname]);

  // Recents record the module page, with the deep link kept so a record reopens directly.
  const locatedLabel = located?.module.label;
  useEffect(() => {
    if (locatedLabel) recordVisit(location.pathname + location.search, locatedLabel);
  }, [location.pathname, location.search, locatedLabel, recordVisit]);

  /** Infinity Mail is its own application; the desktop client can only launch it. */
  const openMail = useCallback(async () => {
    const result = await desktop?.openMail().catch(() => 'not_installed' as const);
    if (result !== 'opened') {
      notify({
        severity: 'warning',
        title: 'Infinity Mail is not installed',
        body: 'Install Infinity Mail on this computer to open your mailbox from here.',
      });
    }
  }, [notify]);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), [setSidebarCollapsed]);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  /**
   * "/" focuses search, Cmd/Ctrl+K opens the palette, Cmd/Ctrl+\ collapses the sidebar.
   * The modifier shortcuts work while typing; "/" deliberately does not.
   */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (mod && event.key === '\\') {
        event.preventDefault();
        toggleSidebar();
      } else if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSidebar]);

  /**
   * Sidebar badge counts. Refreshed by the realtime map rather than polled: the
   * invalidation list includes '/me/activity' for every event that could change one.
   */
  const activity = useQuery<Record<string, number>>('/me/activity', (signal) =>
    api.get('/me/activity', signal),
  );

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

  const currentModule = located?.module.label ?? 'Workspace';
  const count = (key?: string) => (key ? activity.data?.[key] ?? 0 : 0);
  const areaCount = (area: NavArea) => area.modules.reduce((sum, m) => sum + count(m.badge), 0);
  const badgeText = (n: number) => (n > 99 ? '99+' : String(n));
  const favouriteModules = prefs.favourites
    .map((to) => findModule(to))
    .filter((m): m is NonNullable<typeof m> => !!m && allowed(m, can));
  const shortcut = isMac ? '⌘K' : 'Ctrl K';

  return (
    <div className={`ws-shell ${sidebarCollapsed ? 'ws-collapsed' : ''} ${navOpen ? 'ws-nav-open' : ''}`}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <div className="ws-nav" id="module-navigation">
        <nav className="ws-rail" aria-label="Product areas">
          <div className="ws-rail-brand">
            <Logo size={30} tone="inverse" />
          </div>
          <ul className="ws-rail-list">
            {areas.map((area) => {
              const selected = area.id === activeArea?.id;
              const current = area.id === located?.area.id;
              const n = areaCount(area);
              return (
                <li key={area.id}>
                  <button
                    type="button"
                    className={`ws-rail-item ${selected ? 'is-selected' : ''} ${current ? 'is-current' : ''}`}
                    aria-pressed={selected}
                    aria-label={n > 0 ? `${area.label}, ${n} new` : area.label}
                    title={area.label}
                    onClick={() => {
                      /* Collapsed, the rail is the whole navigation: an area opens its
                         first module. Expanded, it previews that area's modules. */
                      if (sidebarCollapsed) navigate(area.modules[0].to);
                      else setPreviewArea(area.id === located?.area.id ? null : area.id);
                    }}
                  >
                    <area.icon size={19} aria-hidden="true" />
                    <span className="ws-rail-label" aria-hidden="true">{area.short}</span>
                    {n > 0 ? <span className="ws-rail-dot" aria-hidden="true" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="ws-rail-foot">
            <button type="button" className="ws-rail-item" onClick={() => setPaletteOpen(true)}
              aria-label={`Command palette (${shortcut})`} title={`Command palette (${shortcut})`}>
              <CommandIcon size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ws-rail-item ws-collapse-toggle"
              aria-expanded={!sidebarCollapsed}
              aria-controls="area-navigation"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar (${isMac ? '⌘' : 'Ctrl+'}\\)`}
              onClick={toggleSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <span className={`ws-live connection-${connection}`} role="status"
              title={connection === 'open' ? 'Live' : connection === 'reconnecting' ? 'Reconnecting…'
                : connection === 'connecting' ? 'Connecting…' : 'Offline'}>
              <span className="connection-dot" aria-hidden="true" />
              <span className="visually-hidden">
                {connection === 'open' ? 'Live' : connection === 'reconnecting' ? 'Reconnecting'
                  : connection === 'connecting' ? 'Connecting' : 'Offline'}
              </span>
            </span>
          </div>
        </nav>

        {activeArea ? (
          <nav className="ws-subnav" id="area-navigation" aria-label={`${activeArea.label} modules`}
            hidden={sidebarCollapsed && !navOpen}>
            <div className="ws-subnav-head">
              <span className="ws-subnav-company">{session?.company?.name ?? 'Infinity Workspace'}</span>
              <h2>{activeArea.label}</h2>
            </div>

            <div className="ws-subnav-scroll">
              <ul className="ws-subnav-list">
                {activeArea.modules.map((m) => {
                  const fav = prefs.favourites.includes(m.to);
                  const n = count(m.badge);
                  return (
                    <li key={m.to} className="ws-subnav-row">
                      <NavLink
                        to={m.to}
                        end={false}
                        className={() => `ws-subnav-item ${located?.module.to === m.to ? 'is-active' : ''}`}
                        aria-current={located?.module.to === m.to ? 'page' : undefined}
                      >
                        <m.icon size={16} aria-hidden="true" />
                        <span className="ws-subnav-label">{m.label}</span>
                        {n > 0 ? (
                          /* The number alone reads as decoration to a screen reader; the
                             label says what it counts. */
                          <span className="nav-badge" aria-label={`${n} new in ${m.label}`}>{badgeText(n)}</span>
                        ) : null}
                      </NavLink>
                      <button
                        type="button"
                        className={`ws-fav ${fav ? 'is-on' : ''}`}
                        aria-pressed={fav}
                        aria-label={fav ? `Remove ${m.label} from favourites` : `Add ${m.label} to favourites`}
                        title={fav ? 'Remove from favourites' : 'Add to favourites'}
                        onClick={() => prefs.toggleFavourite(m.to)}
                      >
                        <Star size={13} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>

              {isDesktop && activeArea.id === 'communication' ? (
                <button type="button" className="ws-subnav-item ws-subnav-external" onClick={() => void openMail()}>
                  <Mail size={16} aria-hidden="true" />
                  <span className="ws-subnav-label">Infinity Mail</span>
                  <ExternalLink size={13} aria-hidden="true" />
                </button>
              ) : null}

              {favouriteModules.length > 0 ? (
                <section className="ws-subnav-section" aria-label="Favourites">
                  <h3>Favourites</h3>
                  <ul className="ws-subnav-list">
                    {favouriteModules.map((m) => (
                      <li key={m.to}>
                        <NavLink to={m.to} className="ws-subnav-item ws-subnav-compact">
                          <m.icon size={15} aria-hidden="true" />
                          <span className="ws-subnav-label">{m.label}</span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {prefs.recents.filter((r) => r.path !== location.pathname + location.search).length > 0 ? (
                <section className="ws-subnav-section" aria-label="Recently visited">
                  <h3>Recent</h3>
                  <ul className="ws-subnav-list">
                    {prefs.recents
                      .filter((r) => r.path !== location.pathname + location.search)
                      .slice(0, 5)
                      .map((r) => (
                        <li key={r.path}>
                          <Link to={r.path} className="ws-subnav-item ws-subnav-compact" title={r.path}>
                            <Clock3 size={14} aria-hidden="true" />
                            <span className="ws-subnav-label">{r.label}</span>
                            <span className="ws-subnav-meta">{relativeTime(new Date(r.visitedAt).toISOString())}</span>
                          </Link>
                        </li>
                      ))}
                  </ul>
                </section>
              ) : null}
            </div>

            <div className="ws-subnav-foot">
              <span className="avatar" style={{ background: user?.avatarColor ?? '#f2c14e' }} aria-hidden="true">
                {initials(user?.displayName ?? '?')}
              </span>
              <div>
                <strong>{user?.displayName}</strong>
                <span>{user?.email ?? ''}</span>
              </div>
            </div>
          </nav>
        ) : null}
      </div>

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

          <div className="ws-crumbs">
            {located ? (
              <nav aria-label="Breadcrumb">
                <ol>
                  <li>{located.area.label}</li>
                  <li aria-hidden="true"><ChevronRight size={13} /></li>
                  <li>
                    {location.pathname === located.module.to
                      ? <span aria-current="page">{located.module.label}</span>
                      : <Link to={located.module.to}>{located.module.label}</Link>}
                  </li>
                </ol>
              </nav>
            ) : null}
            <h1 className="page-title">{currentModule}</h1>
          </div>

          <button type="button" className="ws-palette-trigger" onClick={() => setPaletteOpen(true)}
            aria-label={`Open command palette (${shortcut})`}>
            <CommandIcon size={14} aria-hidden="true" />
            <span>Go to…</span>
            <kbd>{shortcut}</kbd>
          </button>

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

        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          areas={areas}
          recents={prefs.recents}
          favourites={prefs.favourites}
          canSearch={can('search.query')}
          onToggleSidebar={toggleSidebar}
          onOpenMail={isDesktop ? () => void openMail() : undefined}
        />

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

  /*
   * Clearing is a separate act from reading, and the panel only had the second.
   * "Mark all read" removed the bold and left everything in place, so the list filled up
   * with things already dealt with and only ever shrank when retention caught up.
   */
  const clearAll = async () => {
    await api.delete('/me/notifications').catch(() => undefined);
    invalidate('/me/notifications');
  };

  const clearOne = async (id: string) => {
    await api.delete(`/me/notifications/${id}`).catch(() => undefined);
    invalidate('/me/notifications');
  };

  return (
    <section className="notification-panel" aria-label="Notifications">
      <header>
        <h2>Notifications</h2>
        <div>
          <Link to="/notifications" className="ghost-button" onClick={onClose}>View all</Link>
          {notifications.length > 0 ? (
            <>
              <button type="button" className="ghost-button" onClick={markAllRead}>
                Mark all read
              </button>
              <button type="button" className="ghost-button" onClick={clearAll}>
                Clear all
              </button>
            </>
          ) : null}
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
              {/* A sibling of the link, not inside it: a button nested in an anchor is
                  invalid, and clicking it would navigate as well as clear. */}
              <button
                type="button"
                className="icon-button notification-clear"
                aria-label={`Clear: ${notification.title}`}
                onClick={() => void clearOne(notification.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
