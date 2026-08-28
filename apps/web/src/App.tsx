/**
 * Application root: routing, session gating and the authenticated shell.
 *
 * Every module is a deep-linkable route, so refresh restores the view and browser
 * history behaves as expected (blueprint 16).
 */
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session';
import { Loading } from './components/States';
import { Shell } from './components/Shell';
import SignIn from './routes/SignIn';
import Activate from './routes/Activate';
import Clients from './routes/Clients';
import Leave from './routes/Leave';
import Docs from './routes/Docs';
import Finance from './routes/Finance';
import SharedResource from './routes/SharedResource';
import ResetPassword from './routes/ResetPassword';
import './App.css';

// Modules load on demand so the initial sign-in payload stays small.
const Command = lazy(() => import('./routes/Command'));
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
                  <Route path="/command" element={<Command />} />
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
                  <Route path="/finance" element={<Finance />} />
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
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}
