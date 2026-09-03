/**
 * The public web surface.
 *
 * Four flows involve people who cannot be asked to install the desktop application: a
 * client opening a share link, a new joiner activating an account before they have the
 * app, anyone resetting a password from a machine they are locked out of, and — the one
 * with an account behind it — a client using the portal.
 *
 * The portal is the only authenticated area here, so the session provider wraps that
 * branch alone. It also brings its own small shell rather than the workspace one, which
 * would drag the whole authenticated application onto a public host.
 *
 * This is a separate entry point rather than a separate codebase. It imports the same
 * components, the same design tokens and the same API client as the desktop renderer, so
 * the two cannot drift - but it ships without the session provider, the shell, or any of
 * the twenty-one authenticated modules, none of which a recipient should be downloading.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Activate from './routes/Activate';
import ResetPassword from './routes/ResetPassword';
import SharedResource from './routes/SharedResource';
import { SessionProvider } from './lib/session';
import { NotifyProvider } from './lib/notify';
import { PortalShell } from './routes/portal/PortalShell';
import { PortalSignIn } from './routes/portal/PortalSignIn';
import { PortalHome } from './routes/portal/PortalHome';
import { PortalInvoices, PortalQuotations } from './routes/portal/PortalInvoices';
import { PortalDocuments } from './routes/portal/PortalShared';
import { PortalTasks } from './routes/portal/PortalTasks';
import { PortalPayments, PortalSend } from './routes/portal/PortalBilling';
import { PortalMeetings, PortalNotices } from './routes/portal/PortalMeetings';
import { PortalGuard } from './routes/portal/PortalGuard';
import './App.css';
import './styles/portal.css';

/**
 * Anything else here is somebody following a stale or mistyped link. It says so plainly
 * rather than pointing them at a sign-in page they have no account for.
 */
function NotHere() {
  return (
    <main className="share-page">
      <section className="share-card">
        <h1>This link is not valid</h1>
        <p className="auth-lead">
          It may have expired or been mistyped. Ask whoever sent it for a new one.
        </p>
      </section>
    </main>
  );
}

export default function PublicApp() {
  return (
    <BrowserRouter>
      <NotifyProvider>
      <SessionProvider>
      <Routes>
        <Route path="/shared/:token" element={<SharedResource />} />

        {/* The portal. Everything below the guard requires a signed-in guest. */}
        <Route path="/portal/sign-in" element={<PortalSignIn />} />
        <Route path="/portal/activate" element={<Activate portal />} />
        <Route
          path="/portal"
          element={
            <PortalGuard>
              <PortalShell />
            </PortalGuard>
          }
        >
          <Route index element={<PortalHome />} />
          <Route path="invoices" element={<PortalInvoices />} />
          <Route path="quotations" element={<PortalQuotations />} />
          <Route path="payments" element={<PortalPayments />} />
          <Route path="documents" element={<PortalDocuments />} />
          <Route path="send" element={<PortalSend />} />
          <Route path="meetings" element={<PortalMeetings />} />
          <Route path="tasks" element={<PortalTasks />} />
          <Route path="notices" element={<PortalNotices />} />
        </Route>

        <Route path="/activate" element={<Activate />} />
        <Route path="/reset" element={<ResetPassword />} />
        {/* Someone landing on the bare domain is almost always following a link that
            lost its path, so the message is the same as any other dead link. */}
        <Route path="/" element={<Navigate to="/not-found" replace />} />
        <Route path="*" element={<NotHere />} />
      </Routes>
      </SessionProvider>
      </NotifyProvider>
    </BrowserRouter>
  );
}
