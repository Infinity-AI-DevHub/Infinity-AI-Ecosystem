/**
 * Password recovery.
 *
 * Two screens behind one route. Without a token it asks for an address and starts a
 * reset; with one it sets the new password. They live together because they are one
 * journey, and because the request screen must never hint at whether an address is
 * known - keeping them in the same file makes that easy to see when reading it.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { api, ApiError, NetworkError } from '../lib/api';
import { FieldMessage, FormError } from '../components/States';
import { setNotice } from '../lib/notice';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  return token ? <SetNewPassword token={token} /> : <RequestReset />;
}

function RequestReset() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/password/forgot', { email });
      setSent(true);
    } catch (err) {
      // A rate limit or an outage is worth showing. Whether the address exists is not,
      // and the server does not tell us either.
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="auth-success" role="status">
            <MailCheck size={18} aria-hidden="true" />
            <div>
              <strong>Check your email</strong>
              <p>
                If <strong>{email}</strong> has an account, a reset link is on its way. It
                expires in an hour and can be used once.
              </p>
            </div>
          </div>
          <p className="field-hint">
            Nothing arrived? Check spam, then ask your administrator - they can confirm the
            address on file.
          </p>
          <Link className="ghost-button" to="/sign-in">Back to sign in</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Reset your password</h1>
        <p className="auth-lead">
          Enter your work email address and we will send you a link to set a new password.
        </p>

        <FormError error={error} />

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="reset-email">Work email address</label>
            <input
              id="reset-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />
          </div>
          <button type="submit" className="primary-button" disabled={pending || !email}>
            {pending ? 'Sending…' : 'Send reset link'}
          </button>
        </form>

        <p className="field-hint" style={{ marginTop: 'var(--sp-4)' }}>
          <Link to="/sign-in">Back to sign in</Link>
        </p>
      </section>
    </main>
  );
}

function SetNewPassword({ token }: { token: string }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError(
        new ApiError(422, 'unprocessable', 'The two passwords do not match', [
          { field: 'confirmation', message: 'Enter the same password twice' },
        ]),
      );
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/password/reset', { token, password });
      setDone(true);
      setNotice('Your password was reset. Sign in with your new password.');
      setTimeout(() => navigate('/sign-in', { replace: true }), 1200);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="auth-success" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div>
              <strong>Password reset</strong>
              <p>Taking you to sign in…</p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Choose a new password</h1>
        <p className="auth-lead">
          This link works once. Setting a new password signs you out on every device.
        </p>

        <FormError error={error} />

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="reset-password">New password</label>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
            />
            <p className="field-hint">At least 12 characters.</p>
            <FieldMessage
              id="reset-password"
              message={error instanceof ApiError ? error.fieldMessage('password') : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor="reset-confirmation">Confirm new password</label>
            <input
              id="reset-confirmation"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
            />
            <FieldMessage
              id="reset-confirmation"
              message={error instanceof ApiError ? error.fieldMessage('confirmation') : undefined}
            />
          </div>
          <button type="submit" className="primary-button" disabled={pending}>
            {pending ? 'Setting…' : 'Set new password'}
          </button>
        </form>
      </section>
    </main>
  );
}
