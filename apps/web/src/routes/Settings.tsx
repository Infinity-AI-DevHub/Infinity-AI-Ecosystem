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
import { AsyncSection, FormError } from '../components/States';
import { formatDateTime, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import { setNotice } from '../lib/notice';

type Delegation = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  from_name: string;
  to_name: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  revoked_at: string | null;
};

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

  const delegations = useQuery<{ items: Delegation[] }>('/delegations', (signal) =>
    api.get('/delegations', signal),
  );
  const colleagues = useQuery<{ items: User[] }>('/users?limit=100&status=active', (signal) =>
    api.get('/users?limit=100&status=active', signal),
  );

  const [coverTo, setCoverTo] = useState('');
  const [coverFrom, setCoverFrom] = useState('');
  const [coverUntil, setCoverUntil] = useState('');
  const [coverReason, setCoverReason] = useState('');
  const [reassign, setReassign] = useState(true);

  const arrangeCover = useMutation(
    async () =>
      api.post('/delegations', {
        toUserId: coverTo,
        startsAt: new Date(`${coverFrom}T00:00:00Z`).toISOString(),
        endsAt: new Date(`${coverUntil}T23:59:59Z`).toISOString(),
        reason: coverReason || null,
        reassignExisting: reassign,
      }),
    {
      invalidates: ['/delegations'],
      onSuccess: () => {
        setCoverTo('');
        setCoverFrom('');
        setCoverUntil('');
        setCoverReason('');
      },
    },
  );

  const withdrawCover = useMutation(async (id: string) => api.delete(`/delegations/${id}`), {
    invalidates: ['/delegations'],
  });

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
        // Every session is now invalid, including this one. Say so on the way out: a
        // sign-in screen that appears without explanation is indistinguishable from a
        // session that timed out, and leaves the person unsure the change even took.
        setNotice('Your password was changed. Sign in again with your new password.');
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
          <FormError error={saveProfile.error} />
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

          <FormError error={changePassword.error} />

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

        <section className="panel" aria-labelledby="cover-heading">
          <h3 id="cover-heading">Cover while you are away</h3>
          <p className="field-hint">
            Approvals routed to you go to whoever is covering, for as long as the window
            lasts. It ends on its own, so there is nothing to remember to turn off.
          </p>

          <FormError error={arrangeCover.error} />

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void arrangeCover.mutate();
            }}
          >
            <div className="field">
              <label htmlFor="cover-to">Who is covering</label>
              <select id="cover-to" value={coverTo} onChange={(e) => setCoverTo(e.target.value)} required>
                <option value="">Choose a colleague…</option>
                {(colleagues.data?.items ?? [])
                  .filter((person) => person.id !== user?.id)
                  .map((person) => (
                    <option key={person.id} value={person.id}>{person.displayName}</option>
                  ))}
              </select>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="cover-from">From</label>
                <input id="cover-from" type="date" value={coverFrom} onChange={(e) => setCoverFrom(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="cover-until">Until</label>
                <input id="cover-until" type="date" value={coverUntil} min={coverFrom || undefined} onChange={(e) => setCoverUntil(e.target.value)} required />
              </div>
            </div>
            <div className="field">
              <label htmlFor="cover-reason">Reason (optional)</label>
              <input id="cover-reason" value={coverReason} onChange={(e) => setCoverReason(e.target.value)} placeholder="Annual leave" />
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={reassign} onChange={(e) => setReassign(e.target.checked)} />
              Also hand over decisions already waiting on me
            </label>
            <p className="field-hint">
              Leave this on unless you intend to come back to them yourself — cover that
              only applies to new requests is not cover.
            </p>
            <button
              type="submit"
              className="primary-button"
              disabled={arrangeCover.pending || !coverTo || !coverFrom || !coverUntil}
            >
              {arrangeCover.pending ? 'Arranging…' : 'Arrange cover'}
            </button>
          </form>

          <h4>Arranged</h4>
          <AsyncSection query={delegations}>
            {(data) =>
              data.items.length === 0 ? (
                <p className="panel-empty">No cover arranged.</p>
              ) : (
                <ul className="delegation-list">
                  {data.items.map((delegation) => {
                    const outgoing = delegation.from_user_id === user?.id;
                    const withdrawn = Boolean(delegation.revoked_at);
                    const ended = new Date(delegation.ends_at) < new Date();
                    return (
                      <li key={delegation.id} className={withdrawn || ended ? 'delegation-done' : ''}>
                        <div>
                          <strong>
                            {outgoing ? `To ${delegation.to_name}` : `From ${delegation.from_name}`}
                          </strong>
                          <span>
                            {formatDateTime(delegation.starts_at).split(',')[0]} –{' '}
                            {formatDateTime(delegation.ends_at).split(',')[0]}
                            {delegation.reason ? ` · ${delegation.reason}` : ''}
                          </span>
                        </div>
                        {withdrawn ? (
                          <span className="status-tag">Withdrawn</span>
                        ) : ended ? (
                          <span className="status-tag">Ended</span>
                        ) : outgoing ? (
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={withdrawCover.pending}
                            onClick={() => void withdrawCover.mutate(delegation.id)}
                          >
                            Withdraw
                          </button>
                        ) : (
                          <span className="status-tag status-active">Active</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )
            }
          </AsyncSection>
          <FormError error={withdrawCover.error} />
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
