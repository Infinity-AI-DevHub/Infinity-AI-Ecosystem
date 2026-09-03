/**
 * Where a client signs in.
 *
 * Separate from the workspace sign-in because the two fail differently. An employee who
 * mistypes a password needs to try again; a client who ends up here with a staff account,
 * or whose access has expired, needs to be told which is which — otherwise they retype a
 * correct password until they give up and email somebody.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, NetworkError, rememberCsrfToken } from '../../lib/api';
import { useSession } from '../../lib/session';

export function PortalSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useSession();
  const navigate = useNavigate();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      /**
       * The browser exchange, not the desktop one. `/auth/token` returns a token pair
       * for the OS keystore; a browser has nowhere to put it and would sign in to a
       * session it cannot then use. `/auth/login` sets the cookie instead.
       */
      const grant = await api.post<{ status: 'authenticated'; csrfToken: string }>(
        '/auth/login',
        { email: email.trim(), password },
      );
      // Kept in memory because the portal cannot read the cookie carrying it: it is
      // served from a different host than the API, so the cookie is out of its scope.
      rememberCsrfToken(grant.csrfToken);
      setPassword('');
      await refresh();
      navigate('/portal', { replace: true });
    } catch (err) {
      if (err instanceof NetworkError) {
        setError('We could not reach Infinity AI. Check your connection and try again.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('That email address and password do not match.');
      } else if (err instanceof ApiError && err.status === 403) {
        // The likeliest cause by far, and the one the person cannot diagnose themselves.
        setError('Your access to this portal has ended. Ask your contact here to renew it.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="share-page">
      <section className="share-card portal-signin">
        <span className="portal-mark portal-mark-lg" aria-hidden="true">∞</span>
        <h1>Client portal</h1>
        <p className="auth-lead">
          Sign in to see your invoices, quotations and everything shared with you.
        </p>

        <form onSubmit={submit}>
          <label className="field">
            <span>Email address</span>
            <input
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error ? <p className="field-error" role="alert">{error}</p> : null}

          <button type="submit" className="primary-button portal-submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="field-hint portal-signin-foot">
          Employees of Infinity AI should use the desktop app instead.
        </p>
      </section>
    </main>
  );
}
