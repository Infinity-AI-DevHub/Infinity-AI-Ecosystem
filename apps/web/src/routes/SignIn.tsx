/**
 * Sign-in (blueprint 03/16).
 *
 * The form never reveals whether an address exists, keeps the password out of any
 * persistent store, and announces errors to assistive technology.
 */
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { api, ApiError, NetworkError } from '../lib/api';
import { useSession } from '../lib/session';
import { isDesktop } from '../lib/desktop';
import { setGrant, type Grant } from '../lib/tokens';
import { clearNotice, readNotice } from '../lib/notice';
import { FieldMessage } from '../components/States';
import { Logo } from '../components/Logo';

function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string') return '/command';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/command';
  return value;
}

export default function SignIn() {
  const { status, refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath((location.state as { from?: string } | null)?.from);
  const notice = readNotice();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [pending, setPending] = useState(false);

  if (status === 'authenticated') return <Navigate to={returnTo} replace />;

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      /**
       * Two sign-in endpoints for two credential shapes. The desktop exchange returns a
       * token pair which goes straight to the OS keystore; the browser one sets a cookie
       * the client never reads.
       */
      if (isDesktop) {
        const grant = await api.post<Grant>('/auth/token', {
          email,
          password,
          device: navigator.platform || 'Desktop',
        });
        await setGrant(grant);
      } else {
        await api.post<{ status: 'authenticated'; csrfToken: string }>('/auth/login', {
          email,
          password,
        });
      }
      // The password is discarded as soon as it is no longer needed.
      setPassword('');
      clearNotice();
      await refresh();
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-lockup">
          <Logo size={34} tone="brand" />
          <div>
            {/* The product name is the page's heading, not decoration. Every other route
                carries exactly one h1; without this the first screen anyone sees is the
                only one a screen reader cannot announce the purpose of. */}
            <h1 className="brand-heading">Infinity Workspace</h1>
            <span>Sign in to your company workspace</span>
          </div>
        </div>

        {notice ? (
          <div className="auth-success" role="status">
            <div><p>{notice}</p></div>
          </div>
        ) : null}

        {error ? (
          <div className="auth-error" role="alert">
            <p>{error.message}</p>
            {error instanceof ApiError && error.code === 'account_unavailable' ? (
              <p className="auth-error-help">Contact your administrator to restore access.</p>
            ) : null}
          </div>
        ) : null}

        <form onSubmit={submitCredentials} noValidate>
            <div className="field">
              <label htmlFor="email">Work email address</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-describedby={error ? 'signin-error' : undefined}
                autoFocus
              />
              <FieldMessage
                id="email-error"
                message={error instanceof ApiError ? error.fieldMessage('email') : undefined}
              />
            </div>

            <div className="field">
              <div className="label-row">
                <label htmlFor="password">Password</label>
                <Link className="field-link" to="/reset">Forgot password?</Link>
              </div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <button type="submit" className="primary-button" disabled={pending}>
              <KeyRound size={16} aria-hidden="true" />
              {pending ? 'Signing in…' : 'Sign in'}
            </button>
        </form>
      </section>
    </main>
  );
}
