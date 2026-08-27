/**
 * Personal settings: profile, password and active sessions.
 *
 * Changing a password deliberately ends every session, including this one, so a
 * compromised session cannot survive the change.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Monitor } from 'lucide-react';
import { api, type User } from '../lib/api';
import { useMutation, useQuery } from '../lib/query';
import { AsyncSection } from '../components/States';
import { formatDateTime, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type SessionRecord = {
  id: string;
  device: string | null;
  ip: string | null;
  user_agent: string | null;
  last_seen_at: string;
  created_at: string;
  expires_at: string;
};

export default function Settings() {
  const { session, refresh } = useSession();
  const navigate = useNavigate();
  const user = session?.user;

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [title, setTitle] = useState(user?.title ?? '');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [saved, setSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const sessions = useQuery<{ items: SessionRecord[] }>('/auth/sessions', (signal) =>
    api.get('/auth/sessions', signal),
  );

  const saveProfile = useMutation(
    async () => api.patch<User>('/me', { displayName, title: title || null, timezone }),
    {
      invalidates: ['/me'],
      onSuccess: async () => {
        setSaved(true);
        await refresh();
      },
    },
  );

  const changePassword = useMutation(
    async () => api.post('/auth/password', { currentPassword, newPassword }),
    {
      onSuccess: () => {
        // Every session is now invalid, including this one.
        navigate('/sign-in', { replace: true });
      },
    },
  );

  const revoke = useMutation(async (id: string) => api.delete(`/auth/sessions/${id}`), {
    invalidates: ['/auth/sessions'],
  });

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Your settings</h2>
          <p>Profile, password and signed-in devices.</p>
        </div>
      </header>

      <div className="settings-grid">
        <section className="panel" aria-labelledby="profile-heading">
          <h3 id="profile-heading">Profile</h3>
          {saveProfile.error ? (
            <div className="auth-error" role="alert"><p>{saveProfile.error.message}</p></div>
          ) : null}
          {saved ? <p className="save-confirmation" role="status">Profile saved.</p> : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              void saveProfile.mutate();
            }}
          >
            <div className="field">
              <label htmlFor="profile-name">Display name</label>
              <input
                id="profile-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="profile-title">Job title</label>
              <input
                id="profile-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-timezone">Time zone</label>
              <input
                id="profile-timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Asia/Colombo"
              />
              <p className="field-hint">
                Meetings are shown in this zone. Use an IANA identifier.
              </p>
            </div>
            <button type="submit" className="primary-button" disabled={saveProfile.pending}>
              {saveProfile.pending ? 'Saving…' : 'Save profile'}
            </button>
          </form>
        </section>

        <section className="panel" aria-labelledby="security-heading">
          <h3 id="security-heading">Security</h3>
          <dl className="detail-list">
            <div>
              <dt>Access level</dt>
              <dd>{titleCase(user?.accessLevel ?? '')}</dd>
            </div>
            <div>
              <dt>Company</dt>
              <dd>{session?.company?.name ?? '—'}</dd>
            </div>
          </dl>

          {changePassword.error ? (
            <div className="auth-error" role="alert">
              <p>{changePassword.error.message}</p>
              {'fields' in changePassword.error && changePassword.error.fields.length > 0 ? (
                <ul>
                  {changePassword.error.fields.map((field) => (
                    <li key={`${field.field}-${field.message}`}>{field.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void changePassword.mutate();
            }}
          >
            <h4>Change password</h4>
            <div className="field">
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="replacement-password">New password</label>
              <input
                id="replacement-password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
              <p className="field-hint">
                At least 12 characters. Changing it signs you out everywhere.
              </p>
            </div>
            <button type="submit" className="primary-button" disabled={changePassword.pending}>
              {changePassword.pending ? 'Updating…' : 'Change password'}
            </button>
          </form>
        </section>

        <section className="panel" aria-labelledby="sessions-heading">
          <h3 id="sessions-heading">Signed-in devices</h3>
          <AsyncSection query={sessions}>
            {(data) => (
              <ul className="session-list">
                {data.items.map((record) => (
                  <li key={record.id}>
                    <Monitor size={16} aria-hidden="true" />
                    <div>
                      <strong>{record.user_agent?.slice(0, 60) ?? 'Unknown device'}</strong>
                      <span>
                        {record.ip ?? 'unknown address'} · last active{' '}
                        <time dateTime={record.last_seen_at}>
                          {relativeTime(record.last_seen_at)}
                        </time>
                      </span>
                      <span className="field-hint">
                        Expires {formatDateTime(record.expires_at)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void revoke.mutate(record.id)}
                      disabled={revoke.pending}
                    >
                      <LogOut size={14} aria-hidden="true" /> Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </AsyncSection>
        </section>
      </div>
    </div>
  );
}
