/**
 * Account activation (blueprint 03).
 *
 * The invited person consumes a single-use invitation and sets their own password.
 * No password is ever generated for them or sent by email.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiError, NetworkError, type User } from '../lib/api';
import { FieldMessage, FormError } from '../components/States';

type Activation = { user: User };

export default function Activate() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [pending, setPending] = useState(false);
  const [activated, setActivated] = useState(false);

  if (!token) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <h1>This activation link is not valid</h1>
          <p>Ask your administrator to send you a new invitation.</p>
          <Link className="ghost-button" to="/sign-in">Go to sign in</Link>
        </section>
      </main>
    );
  }

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
      await api.post<Activation>('/auth/activate', { token, password });
      setActivated(true);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  if (activated) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="auth-success" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div>
              <strong>Your account is ready</strong>
              <p>You can sign in with your new password.</p>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => navigate('/sign-in', { replace: true })}
            >
              Continue to sign in
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Activate your account</h1>
        <p className="auth-lead">
          Choose a password only you know. It must be at least 12 characters and must not
          contain your email address.
        </p>

        <FormError error={error} />

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
            <FieldMessage
              id="password-error"
              message={error instanceof ApiError ? error.fieldMessage('password') : undefined}
            />
          </div>

          <div className="field">
            <label htmlFor="confirm-password">Repeat password</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <FieldMessage
              id="confirmation-error"
              message={error instanceof ApiError ? error.fieldMessage('confirmation') : undefined}
            />
          </div>

          <button type="submit" className="primary-button" disabled={pending}>
            {pending ? 'Activating…' : 'Set password and continue'}
          </button>
        </form>
      </section>
    </main>
  );
}
