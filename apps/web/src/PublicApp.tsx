/**
 * The public web surface.
 *
 * Three flows involve people who cannot be asked to install the desktop application: a
 * client opening a share link, a new joiner activating an account before they have the
 * app, and anyone resetting a password from a machine they are locked out of. Those stay
 * on the web.
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
import './App.css';

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
      <Routes>
        <Route path="/shared/:token" element={<SharedResource />} />
        <Route path="/activate" element={<Activate />} />
        <Route path="/reset" element={<ResetPassword />} />
        {/* Someone landing on the bare domain is almost always following a link that
            lost its path, so the message is the same as any other dead link. */}
        <Route path="/" element={<Navigate to="/not-found" replace />} />
        <Route path="*" element={<NotHere />} />
      </Routes>
    </BrowserRouter>
  );
}
