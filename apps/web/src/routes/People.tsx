/**
 * People directory and account administration (blueprint 03).
 *
 * Creating an account issues a single-use activation invitation; no password is ever
 * generated or shown here. Suspension and reactivation are capability-gated on the
 * server, and both are recorded in the audit trail.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, ShieldOff, ShieldCheck, UserPlus } from 'lucide-react';
import { api, idempotencyKey, type Paged, type User } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty } from '../components/States';
import { initials, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Department = { id: string; name: string; headcount: number };

export default function People() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { can, session } = useSession();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);

  const listKey = `/users?limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}${
    statusFilter ? `&status=${statusFilter}` : ''
  }`;
  const people = useQuery<Paged<User>>(listKey, (signal) => api.get(listKey, signal));

  const departments = useQuery<{ items: Department[] }>('/departments', (signal) =>
    api.get('/departments', signal),
  );

  const selected = people.data?.items.find((person) => person.id === userId) ?? null;

  const suspend = useMutation(
    async ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/users/${id}/suspend`, { reason }),
    { invalidates: ['/users'] },
  );

  const reactivate = useMutation(async (id: string) => api.post(`/users/${id}/reactivate`, {}), {
    invalidates: ['/users'],
  });

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>People</h2>
          <p>Your company directory.</p>
        </div>
        {can('user.create') ? (
          <button type="button" className="primary-button" onClick={() => setInviting(true)}>
            <UserPlus size={15} aria-hidden="true" /> Add someone
          </button>
        ) : null}
      </header>

      {invitationUrl ? (
        <div className="auth-success" role="status">
          <div>
            <strong>Account created</strong>
            <p>
              Send this single-use activation link to the person. It expires in 72 hours.
              An email has also been queued.
            </p>
            <code className="invitation-link">{invitationUrl}</code>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => navigator.clipboard?.writeText(invitationUrl)}
          >
            <Copy size={14} aria-hidden="true" /> Copy link
          </button>
          <button type="button" className="ghost-button" onClick={() => setInvitationUrl(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="filter-row">
        <div className="field">
          <label htmlFor="people-search">Search</label>
          <input
            id="people-search"
            type="search"
            value={search}
            placeholder="Name or email"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="people-status">Status</label>
          <select
            id="people-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="">Everyone</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
      </div>

      <div className="split-layout">
        <section className="panel" aria-label="Directory">
          <AsyncSection query={people}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty title="No matches" description="Adjust your search or filters." />
              ) : (
                <ul className="person-list">
                  {data.items.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        className={`person-row ${person.id === userId ? 'person-active' : ''}`}
                        onClick={() => navigate(`/people/${person.id}`)}
                      >
                        <span className="person-avatar" style={{ background: person.avatarColor }}>
                          {initials(person.displayName)}
                        </span>
                        <span className="person-body">
                          <strong>{person.displayName}</strong>
                          <span>{person.title ?? person.email}</span>
                        </span>
                        <span className={`status-tag status-${person.status}`}>
                          {titleCase(person.status)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>

        <section className="panel" aria-label="Person detail">
          {!selected ? (
            <Empty title="Select someone" description="Choose a colleague to see their profile." />
          ) : (
            <article className="person-detail">
              <span
                className="person-avatar person-avatar-large"
                style={{ background: selected.avatarColor }}
                aria-hidden="true"
              >
                {initials(selected.displayName)}
              </span>
              <h3>{selected.displayName}</h3>
              <p className="task-meta">
                {selected.title ?? 'No title recorded'} ·{' '}
                {departments.data?.items.find((d) => d.id === selected.departmentId)?.name ??
                  'No department'}
              </p>

              <dl className="detail-list">
                <div>
                  <dt>Email</dt>
                  <dd>{selected.email}</dd>
                </div>
                <div>
                  <dt>Access level</dt>
                  <dd>{titleCase(selected.accessLevel)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{titleCase(selected.status)}</dd>
                </div>
                <div>
                  <dt>Time zone</dt>
                  <dd>{selected.timezone}</dd>
                </div>
                <div>
                  <dt>Joined</dt>
                  <dd>
                    <time dateTime={selected.createdAt}>{relativeTime(selected.createdAt)}</time>
                  </dd>
                </div>
              </dl>

              {can('user.suspend') && selected.id !== session?.user?.id ? (
                <div className="person-actions">
                  {selected.status === 'suspended' ? (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={reactivate.pending}
                      onClick={() => void reactivate.mutate(selected.id)}
                    >
                      <ShieldCheck size={15} aria-hidden="true" /> Reactivate account
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="danger-button"
                      disabled={suspend.pending}
                      onClick={() => {
                        const reason = window.prompt(
                          'Why is this account being suspended? This is recorded in the audit trail.',
                        );
                        if (reason && reason.trim().length >= 3) {
                          void suspend.mutate({ id: selected.id, reason: reason.trim() });
                        }
                      }}
                    >
                      <ShieldOff size={15} aria-hidden="true" /> Suspend account
                    </button>
                  )}
                  <p className="field-hint">
                    Suspending closes every session and live connection immediately. Mail and
                    files are retained.
                  </p>
                </div>
              ) : null}

              {suspend.error ? (
                <p className="field-error" role="alert">{suspend.error.message}</p>
              ) : null}
              {reactivate.error ? (
                <p className="field-error" role="alert">{reactivate.error.message}</p>
              ) : null}
            </article>
          )}
        </section>
      </div>

      {inviting ? (
        <InviteDialog
          departments={departments.data?.items ?? []}
          onClose={() => setInviting(false)}
          onCreated={(url) => {
            setInviting(false);
            setInvitationUrl(url);
            invalidate('/users');
          }}
        />
      ) : null}
    </div>
  );
}

function InviteDialog({
  departments,
  onClose,
  onCreated,
}: {
  departments: Department[];
  onClose: () => void;
  onCreated: (invitationUrl: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [accessLevel, setAccessLevel] = useState('staff');
  const [departmentId, setDepartmentId] = useState('');
  const key = useMemo(() => idempotencyKey(), []);

  const create = useMutation(
    async () =>
      api.post<{ user: User; invitation: { url: string } }>(
        '/users',
        {
          email,
          displayName,
          title: title || undefined,
          accessLevel,
          departmentId: departmentId || null,
        },
        { idempotencyKey: key },
      ),
    { invalidates: ['/users'], onSuccess: (result) => onCreated(result.invitation.url) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="invite-title">Add someone to the workspace</h3>
        <p className="field-hint">
          They will receive a single-use activation link and choose their own password.
        </p>

        {create.error ? (
          <div className="auth-error" role="alert">
            <p>{create.error.message}</p>
            {'fields' in create.error && create.error.fields.length > 0 ? (
              <ul>
                {create.error.fields.map((field) => (
                  <li key={`${field.field}-${field.message}`}>{field.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="invite-email">Work email address</label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />
            <p className="field-hint">Must use one of your company's verified domains.</p>
          </div>

          <div className="field">
            <label htmlFor="invite-name">Full name</label>
            <input
              id="invite-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="invite-title">Job title</label>
            <input id="invite-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="invite-level">Access level</label>
              <select
                id="invite-level"
                value={accessLevel}
                onChange={(event) => setAccessLevel(event.target.value)}
              >
                {['staff', 'manager', 'auditor', 'admin'].map((level) => (
                  <option key={level} value={level}>{titleCase(level)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="invite-department">Department</label>
              <select
                id="invite-department"
                value={departmentId}
                onChange={(event) => setDepartmentId(event.target.value)}
              >
                <option value="">None</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
