/**
 * Application root: routing, session gating and the authenticated shell.
 *
 * Every module is a deep-linkable route, so refresh restores the view and browser
 * history behaves as expected (blueprint 16).
 */
import { lazy, Suspense } from 'react';
import Attendance from './routes/Attendance';
import { AttendanceProvider } from './lib/attendance';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session';
import { NotifyProvider } from './lib/notify';
import { Toasts } from './components/Toasts';
import { Loading } from './components/States';
import { Shell } from './components/Shell';
import SignIn from './routes/SignIn';
import Activate from './routes/Activate';
import Clients from './routes/Clients';
import Leave from './routes/Leave';
import Docs from './routes/Docs';
import Finance from './routes/Finance';
import Growth from './routes/Growth';
import Reports from './routes/Reports';
import SharedResource from './routes/SharedResource';
import ResetPassword from './routes/ResetPassword';
import './App.css';
import './styles/redesign.css';
import './styles/desktop.css';
import './styles/shell.css';

// Modules load on demand so the initial sign-in payload stays small.
const Home = lazy(() => import('./routes/Home'));
const Reminders = lazy(() => import('./routes/Reminders'));
const Meetings = lazy(() => import('./routes/Meetings'));
const Chat = lazy(() => import('./routes/Chat'));
const Tasks = lazy(() => import('./routes/Tasks'));
const Files = lazy(() => import('./routes/Files'));
const People = lazy(() => import('./routes/People'));
const Approvals = lazy(() => import('./routes/Approvals'));
const Admin = lazy(() => import('./routes/Admin'));
const Announcements = lazy(() => import('./routes/Announcements'));
const Search = lazy(() => import('./routes/Search'));
const Settings = lazy(() => import('./routes/Settings'));
const Messages = lazy(() => import('./routes/Messages'));
const Notifications = lazy(() => import('./routes/Notifications'));
// Service management loads as its own chunks, so a fault there cannot stop the rest of the
// workspace from loading.
const ServiceDesk = lazy(() => import('./routes/service/ServiceDesk'));
const TicketDetail = lazy(() => import('./routes/service/TicketDetail'));
const ServiceSettings = lazy(() => import('./routes/service/ServiceSettings'));
const ServiceAnalytics = lazy(() => import('./routes/service/ServiceAnalytics'));
const KnowledgeList = lazy(() => import('./routes/service/Knowledge'));
const KnowledgeArticle = lazy(() => import('./routes/service/Knowledge').then((m) => ({ default: m.KnowledgeArticle })));
const KnowledgeEditor = lazy(() => import('./routes/service/Knowledge').then((m) => ({ default: m.KnowledgeEditor })));
const ChangeList = lazy(() => import('./routes/service/Changes'));
const ChangeDetail = lazy(() => import('./routes/service/Changes').then((m) => ({ default: m.ChangeDetail })));
const ServiceAssets = lazy(() => import('./routes/service/ServiceAssets'));

/**
 * Route guard. This is a navigation convenience only - the API authorizes every call
 * independently, so reaching a route directly can never grant access to data.
 */
function RequireSession({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'loading') return <Loading label="Checking your session" rows={4} />;
  if (status === 'anonymous') {
    // Preserve where the user was heading so sign-in can return them there.
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/activate" element={<Activate />} />
      <Route path="/reset" element={<ResetPassword />} />
      {/* Outside the authenticated shell: whoever opens this does not work here. */}
      <Route path="/shared/:token" element={<SharedResource />} />
      <Route
        path="/*"
        element={
          <RequireSession>
            <Shell>
              <Suspense fallback={<Loading label="Loading module" rows={5} />}>
                <Routes>
                  <Route path="/" element={<Navigate to="/command" replace />} />
                  <Route path="/command" element={<Home />} />
                  <Route path="/meetings" element={<Meetings />} />
                  <Route path="/meetings/:eventId" element={<Meetings />} />
                  <Route path="/chat" element={<Chat />} />
                  <Route path="/chat/:roomId" element={<Chat />} />
                  <Route path="/tasks" element={<Tasks />} />
                  <Route path="/tasks/:taskId" element={<Tasks />} />
                  <Route path="/files" element={<Files />} />
                  <Route path="/docs" element={<Docs />} />
                  <Route path="/docs/:spaceId" element={<Docs />} />
                  <Route path="/docs/:spaceId/:pageId" element={<Docs />} />
                  <Route path="/reports" element={<Reports />} />
                  <Route path="/growth" element={<Growth />} />
                  <Route path="/finance" element={<Finance />} />
                  <Route path="/reminders" element={<Reminders />} />
                  <Route path="/attendance" element={<Attendance />} />
                  <Route path="/leave" element={<Leave />} />
                  <Route path="/clients" element={<Clients />} />
                  <Route path="/clients/:organizationId" element={<Clients />} />
                  <Route path="/people" element={<People />} />
                  <Route path="/people/:userId" element={<People />} />
                  <Route path="/announcements" element={<Announcements />} />
                  <Route path="/announcements/:announcementId" element={<Announcements />} />
                  <Route path="/approvals" element={<Approvals />} />
                  <Route path="/approvals/:requestId" element={<Approvals />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="/search" element={<Search />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/messages" element={<Messages />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/service" element={<ServiceDesk />} />
                  <Route path="/service/tickets/:ticketId" element={<TicketDetail />} />
                  <Route path="/service/settings" element={<ServiceSettings />} />
                  <Route path="/service/analytics" element={<ServiceAnalytics />} />
                  <Route path="/service/knowledge" element={<KnowledgeList />} />
                  <Route path="/service/knowledge/new" element={<KnowledgeEditor />} />
                  <Route path="/service/knowledge/:articleId" element={<KnowledgeArticle />} />
                  <Route path="/service/knowledge/:articleId/edit" element={<KnowledgeEditor />} />
                  <Route path="/service/changes" element={<ChangeList />} />
                  <Route path="/service/changes/:changeId" element={<ChangeDetail />} />
                  <Route path="/service/assets" element={<ServiceAssets />} />
                  <Route path="*" element={<UnknownRoute />} />
                </Routes>
              </Suspense>
            </Shell>
          </RequireSession>
        }
      />
    </Routes>
  );
}

function UnknownRoute() {
  return (
    <div className="state-block state-empty">
      <h3>That page does not exist</h3>
      <p>Check the address, or return to your command centre.</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <NotifyProvider>
        <SessionProvider>
          <AttendanceProvider>
        <AppRoutes />
          </AttendanceProvider>
        </SessionProvider>
        {/* Outside the session provider: a banner must still be able to say the
            session ended, which is exactly when that provider has no session. */}
        <Toasts />
      </NotifyProvider>
    </BrowserRouter>
  );
}
