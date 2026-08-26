/**
 * Sign-in, including the second-factor step (blueprint 03/16).
 *
 * The form never reveals whether an address exists, keeps the password out of any
 * persistent store, and announces errors to assistive technology.
 */
import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { api, ApiError, NetworkError } from '../lib/api';
import { useSession } from '../lib/session';
import { FieldMessage } from '../components/States';

type Stage = 'credentials' | 'mfa';

export default function SignIn() {
  const { status, refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/command';

  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [pending, setPending] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stage === 'mfa') codeRef.current?.focus();
  }, [stage]);

  if (status === 'authenticated') return <Navigate to={returnTo} replace />;

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api.post<
        | { status: 'mfa_required'; challengeToken: string }
        | { status: 'authenticated'; csrfToken: string }
      >('/auth/login', { email, password });

      if (result.status === 'mfa_required') {
        setChallengeToken(result.challengeToken);
        setStage('mfa');
        // The password is discarded as soon as it is no longer needed.
        setPassword('');
        return;
      }
      await refresh();
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/mfa/verify', { challengeToken, code });
      await refresh();
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
      setCode('');
      codeRef.current?.focus();
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">IW</span>
          <div>
            <strong>Infinity Workspace</strong>
            <span>Sign in to your company workspace</span>
          </div>
        </div>

        {error ? (
          <div className="auth-error" role="alert">
            <p>{error.message}</p>
            {error instanceof ApiError && error.code === 'account_unavailable' ? (
              <p className="auth-error-help">Contact your administrator to restore access.</p>
            ) : null}
          </div>
        ) : null}

        {stage === 'credentials' ? (
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
              <label htmlFor="password">Password</label>
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
        ) : (
          <form onSubmit={submitCode} noValidate>
            <div className="mfa-intro">
              <ShieldCheck size={18} aria-hidden="true" />
              <p>
                Enter the six-digit code from your authenticator app. You can also use one of
                your single-use recovery codes.
              </p>
            </div>

            <div className="field">
              <label htmlFor="code">Verification code</label>
              <input
                id="code"
                ref={codeRef}
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>

            <button type="submit" className="primary-button" disabled={pending}>
              {pending ? 'Verifying…' : 'Verify and continue'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setStage('credentials');
                setError(null);
                setCode('');
              }}
            >
              Start over
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
