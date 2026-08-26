/**
 * Account activation (blueprint 03).
 *
 * The invited person sets their own password and enrols an authenticator. The MFA secret
 * and recovery codes are displayed exactly once, here, and are never persisted by the
 * client - if the person loses them, an administrator must reissue.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Copy, ShieldCheck } from 'lucide-react';
import { api, ApiError, NetworkError, type User } from '../lib/api';
import { FieldMessage } from '../components/States';

type Enrolment = {
  user: User;
  mfa: { secret: string; uri: string };
  recoveryCodes: string[];
};

export default function Activate() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [pending, setPending] = useState(false);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState(false);

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
      setError(new ApiError(422, 'unprocessable', 'The two passwords do not match', [
        { field: 'confirmation', message: 'Enter the same password twice' },
      ]));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await api.post<Enrolment>('/auth/activate', { token, password });
      setEnrolment(result);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  const confirmAuthenticator = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!enrolment) return;
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/mfa/confirm', { userId: enrolment.user.id, code });
      setConfirmed(true);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  if (enrolment) {
    return (
      <main className="auth-page">
        <section className="auth-card auth-card-wide">
          <h1>Set up two-factor verification</h1>
          <p className="auth-lead">
            Your password is set. Add this account to an authenticator app, then confirm the
            first code to finish.
          </p>

          <div className="enrolment-grid">
            <div>
              <h2>1. Add to your authenticator</h2>
              <p className="enrolment-secret-label">Setup key</p>
              <code className="enrolment-secret">{enrolment.mfa.secret}</code>
              <button
                type="button"
                className="ghost-button"
                onClick={() => navigator.clipboard?.writeText(enrolment.mfa.secret)}
              >
                <Copy size={14} aria-hidden="true" /> Copy setup key
              </button>
            </div>

            <div>
              <h2>2. Save your recovery codes</h2>
              <p className="enrolment-warning">
                These are shown once. Store them somewhere safe — each one works a single
                time if you lose your authenticator.
              </p>
              <ul className="recovery-codes">
                {enrolment.recoveryCodes.map((recoveryCode) => (
                  <li key={recoveryCode}><code>{recoveryCode}</code></li>
                ))}
              </ul>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(event) => setSaved(event.target.checked)}
                />
                I have stored my recovery codes
              </label>
            </div>
          </div>

          {confirmed ? (
            <div className="auth-success" role="status">
              <CheckCircle2 size={18} aria-hidden="true" />
              <div>
                <strong>Your account is ready</strong>
                <p>Two-factor verification is active.</p>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => navigate('/sign-in', { replace: true })}
              >
                Continue to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={confirmAuthenticator} noValidate>
              <h2>3. Confirm the first code</h2>
              {error ? <div className="auth-error" role="alert"><p>{error.message}</p></div> : null}
              <div className="field">
                <label htmlFor="confirm-code">Six-digit code</label>
                <input
                  id="confirm-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <button type="submit" className="primary-button" disabled={pending || !saved}>
                <ShieldCheck size={16} aria-hidden="true" />
                {pending ? 'Confirming…' : 'Confirm and finish'}
              </button>
              {!saved ? (
                <p className="field-hint">Confirm you have saved your recovery codes first.</p>
              ) : null}
            </form>
          )}
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

        {error ? (
          <div className="auth-error" role="alert">
            <p>{error.message}</p>
            {error instanceof ApiError && error.fields.length > 0 ? (
              <ul>
                {error.fields.map((field) => (
                  <li key={`${field.field}-${field.message}`}>{field.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

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
