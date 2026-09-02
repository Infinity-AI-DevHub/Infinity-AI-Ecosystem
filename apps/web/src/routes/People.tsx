/**
 * People directory and account administration (blueprint 03).
 *
 * Creating an account issues a single-use activation invitation; no password is ever
 * generated or shown here. Suspension and reactivation are capability-gated on the
 * server, and both are recorded in the audit trail.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, Mail, Plus, ShieldOff, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { api, idempotencyKey, type Paged, type User } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, FormError } from '../components/States';
import { formatCurrency, formatDate, initials, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import { useTextPrompt } from '../components/Prompt';

type Department = { id: string; name: string; headcount: number };

export default function People() {
  const { ask, element: promptDialog } = useTextPrompt();
  const { userId } = useParams();
  const navigate = useNavigate();
  const { can, session } = useSession();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const [invitationNotice, setInvitationNotice] = useState('');
  const [offboarding, setOffboarding] = useState<User | null>(null);

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

  const resendInvitation = useMutation(
    async (id: string) =>
      api.post<{ invitation: { url: string; expiresInHours: number } }>(
        `/users/${id}/invitation`,
        {},
        { idempotencyKey: idempotencyKey() },
      ),
    {
      invalidates: ['/users'],
      onSuccess: (result) => {
        setInvitationUrl(result.invitation.url);
        setInvitationNotice('Invitation resent');
      },
    },
  );

  const changeLevel = useMutation(
    async ({ id, accessLevel, version }: { id: string; accessLevel: string; version: number }) =>
      api.patch(`/users/${id}`, { accessLevel }, { ifMatch: version }),
    { invalidates: ['/users'] },
  );

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
            <strong>{invitationNotice || 'Account created'}</strong>
            <p>
              The previous activation link is no longer valid. This new single-use link
              expires in 72 hours, and a fresh email has been queued.
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
                  <dd>
                    {can('user.update') && selected.id !== session?.user?.id ? (
                      <>
                        <label className="visually-hidden" htmlFor="person-access-level">
                          Access level for {selected.displayName}
                        </label>
                        <select
                          id="person-access-level"
                          className="inline-select"
                          value={selected.accessLevel}
                          disabled={changeLevel.pending || selected.status === 'offboarded'}
                          onChange={(event) =>
                            void changeLevel.mutate({
                              id: selected.id,
                              accessLevel: event.target.value,
                              version: selected.version,
                            })
                          }
                        >
                          {['staff', 'manager', 'auditor', 'admin', 'super_admin'].map((level) => (
                            <option key={level} value={level}>{titleCase(level)}</option>
                          ))}
                        </select>
                      </>
                    ) : (
                      titleCase(selected.accessLevel)
                    )}
                  </dd>
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

              <EmploymentHistory userId={selected.id} />

              {can('user.create') && selected.status === 'invited' ? (
                <div className="person-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={resendInvitation.pending}
                    onClick={() => void resendInvitation.mutate(selected.id)}
                  >
                    <Mail size={15} aria-hidden="true" />
                    {resendInvitation.pending ? 'Sending invitation…' : 'Resend invitation'}
                  </button>
                  <p className="field-hint">
                    Invalidates the old activation link and emails a new one that expires in 72 hours.
                  </p>
                  <FormError error={resendInvitation.error} />
                </div>
              ) : null}

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
                      onClick={async () => {
                        const reason = await ask({
                          title: 'Suspend this account',
                          label: 'Reason',
                          description:
                            'Recorded in the audit trail. Suspending ends every session '
                            + 'immediately, on every device.',
                          minLength: 3,
                          confirmLabel: 'Suspend account',
                          destructive: true,
                        });
                        if (reason) void suspend.mutate({ id: selected.id, reason });
                      }}
                    >
                      <ShieldOff size={15} aria-hidden="true" /> Suspend account
                    </button>
                  )}
                  <p className="field-hint">
                    Suspending closes every session and live connection immediately, and is
                    reversible. Files and history are retained.
                  </p>

                  {selected.status !== 'offboarded' ? (
                    <>
                      <button
                        type="button"
                        className="ghost-button"
                        style={{ marginTop: 'var(--sp-3)' }}
                        onClick={() => setOffboarding(selected)}
                      >
                        <UserMinus size={15} aria-hidden="true" /> Offboard
                      </button>
                      <p className="field-hint">
                        For someone leaving for good. Names who inherits their projects,
                        open tasks, files and direct reports.
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}

              <FormError error={suspend.error} />
              <FormError error={reactivate.error} />
              <FormError error={changeLevel.error} />
            </article>
          )}
        </section>
      </div>

      {offboarding ? (
        <OffboardDialog
          person={offboarding}
          colleagues={(people.data?.items ?? []).filter(
            (p) => p.id !== offboarding.id && p.status === 'active',
          )}
          onClose={() => setOffboarding(null)}
          onDone={() => {
            setOffboarding(null);
            invalidate('/users');
          }}
        />
      ) : null}

      {inviting ? (
        <InviteDialog
          departments={departments.data?.items ?? []}
          onClose={() => setInviting(false)}
          onCreated={(url) => {
            setInviting(false);
            setInvitationUrl(url);
            setInvitationNotice('Account created');
            invalidate('/users');
          }}
        />
      ) : null}
      {promptDialog}
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

        <FormError error={create.error} />

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

/**
 * Offboarding asks one question that suspension never did: who picks this up?
 *
 * The successor is optional but the dialog pushes hard toward naming one, because the
 * alternative is work that belongs to nobody. What actually moved is reported back
 * afterwards rather than assumed - the counts come from the transaction that did it.
 */
function OffboardDialog({
  person,
  colleagues,
  onClose,
  onDone,
}: {
  person: User;
  colleagues: User[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [successorId, setSuccessorId] = useState('');
  const [reason, setReason] = useState('');
  const [lastDay, setLastDay] = useState('');
  const [transferred, setTransferred] = useState<Record<string, number> | null>(null);
  const key = useMemo(() => idempotencyKey(), []);

  const offboard = useMutation(
    async () =>
      api.post<{ transferred: Record<string, number> }>(
        `/users/${person.id}/offboard`,
        { successorId: successorId || null, reason, lastDay: lastDay || null },
        { idempotencyKey: key },
      ),
    { invalidates: ['/users'], onSuccess: (result) => setTransferred(result.transferred) },
  );

  if (transferred) {
    const moved = Object.entries(transferred).filter(([, count]) => count > 0);
    return (
      <div className="dialog-scrim" role="presentation" onClick={onDone}>
        <div
          className="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="offboard-done"
          onClick={(event) => event.stopPropagation()}
        >
          <h3 id="offboard-done">{person.displayName} has been offboarded</h3>
          {moved.length === 0 ? (
            <p className="field-hint">
              Nothing needed transferring. Their access has been closed.
            </p>
          ) : (
            <>
              <p className="field-hint">Their access is closed. This moved to the successor:</p>
              <dl className="detail-list">
                {moved.map(([label, count]) => (
                  <div key={label}>
                    <dt>{titleCase(label.replace(/_/g, ' '))}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          <div className="dialog-actions">
            <button type="button" className="primary-button" onClick={onDone}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="offboard-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="offboard-title">Offboard {person.displayName}</h3>
        <p className="field-hint">
          This is permanent. Their sessions close immediately and they cannot sign in
          again. Use Suspend instead if they may come back.
        </p>

        <HeldEquipment userId={person.id} />

        <FormError error={offboard.error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void offboard.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="offboard-successor">Who takes over their work?</label>
            <select
              id="offboard-successor"
              value={successorId}
              onChange={(event) => setSuccessorId(event.target.value)}
            >
              <option value="">Nobody — release their work</option>
              {colleagues.map((colleague) => (
                <option key={colleague.id} value={colleague.id}>
                  {colleague.displayName}
                </option>
              ))}
            </select>
            <p className="field-hint">
              {successorId
                ? 'Their projects, open tasks, files, folders, direct reports and any approval waiting on them move across.'
                : 'Without a successor their work stays unassigned, and anything waiting on their approval will stall. Only choose this if there is genuinely nobody.'}
            </p>
          </div>

          <div className="field">
            <label htmlFor="offboard-reason">Reason</label>
            <input
              id="offboard-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Resignation, end of contract, …"
              required
              minLength={3}
            />
            <p className="field-hint">Recorded in the audit trail and on the offboarding record.</p>
          </div>

          <div className="field">
            <label htmlFor="offboard-last-day">Last day (optional)</label>
            <input
              id="offboard-last-day"
              type="date"
              value={lastDay}
              onChange={(event) => setLastDay(event.target.value)}
            />
          </div>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="danger-button" disabled={offboard.pending || reason.trim().length < 3}>
              {offboard.pending ? 'Offboarding…' : `Offboard ${person.displayName}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Equipment the departing person still holds.
 *
 * Projects and files move with a database update; a laptop does not. Offboarding is the
 * one moment someone is definitely thinking about this person, so the list belongs here
 * rather than in a report nobody opens - equipment leaving with a departing employee is
 * the commonest way a company loses track of it.
 */
function HeldEquipment({ userId }: { userId: string }) {
  const { can } = useSession();
  const key = can('asset.read') ? `/assets/held-by/${userId}` : null;
  const assets = useQuery<{ items: { id: string; asset_tag: string; name: string; serial_number: string | null }[] }>(
    key,
    (signal) => api.get(key!, signal),
  );

  if (!key || !assets.data || assets.data.items.length === 0) return null;

  return (
    <div className="degraded-notice" role="status">
      <div>
        <strong>
          Still holding {assets.data.items.length} item
          {assets.data.items.length === 1 ? '' : 's'} of equipment
        </strong>
        <p>
          Closing their account does not collect it. Arrange the return before their last
          day, then mark each item back into stock in Finance.
        </p>
        <ul className="held-list">
          {assets.data.items.map((asset) => (
            <li key={asset.id}>
              <code>{asset.asset_tag}</code> {asset.name}
              {asset.serial_number ? <span className="task-meta"> · {asset.serial_number}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Someone's employment history.
 *
 * Shown on their profile rather than in a separate HR module, because the question
 * "when did they join and on what terms" arrives while you are already looking at them.
 * Salary appears only for those entitled to it; when it is withheld the row says so
 * rather than showing a blank, so nobody reads "not allowed" as "not recorded".
 */
function EmploymentHistory({ userId }: { userId: string }) {
  const { can } = useSession();
  const [adding, setAdding] = useState(false);
  const key = `/hr/employment/${userId}`;
  const history = useQuery<{ items: EmploymentEntry[] }>(key, (signal) => api.get(key, signal));

  // Someone with no HR access gets a 403 here; that is expected rather than an error to
  // display, so the whole section simply does not appear for them.
  if (history.error) return null;

  return (
    <div className="employment-section">
      <div className="panel-header">
        <div><h4>Employment</h4></div>
        {can('hr.manage') ? (
          <button type="button" className="ghost-button" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" /> Record change
          </button>
        ) : null}
      </div>

      <AsyncSection query={history}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="field-hint">No employment record yet.</p>
          ) : (
            <ul className="employment-list">
              {data.items.map((entry) => (
                <li key={entry.id} className={entry.effective_to ? 'employment-past' : ''}>
                  <div>
                    <strong>{entry.job_title}</strong>
                    <span>
                      {formatDate(entry.effective_from)}
                      {entry.effective_to ? ` – ${formatDate(entry.effective_to)}` : ' – present'}
                      {' · '}{titleCase(entry.employment_type.replace('_', ' '))}
                      {entry.change_reason ? ` · ${entry.change_reason}` : ''}
                    </span>
                  </div>
                  {entry.salaryVisible && entry.salary !== undefined ? (
                    <span className="employment-salary">
                      {formatCurrency(entry.salary, entry.salary_currency)}
                      <span className="task-meta">/{entry.salary_period}</span>
                    </span>
                  ) : (
                    <span className="task-meta">pay withheld</span>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </AsyncSection>

      {adding ? (
        <EmploymentDialog userId={userId} onClose={() => setAdding(false)} />
      ) : null}
    </div>
  );
}

type EmploymentEntry = {
  id: string;
  job_title: string;
  employment_type: string;
  effective_from: string;
  effective_to: string | null;
  change_reason: string | null;
  salary?: number;
  salaryVisible: boolean;
  salary_currency: string;
  salary_period: string;
};

function EmploymentDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { can } = useSession();
  const [jobTitle, setJobTitle] = useState('');
  const [employmentType, setEmploymentType] = useState('permanent');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [salary, setSalary] = useState('');
  const [changeReason, setChangeReason] = useState('');

  const record = useMutation(
    async () =>
      api.post(`/hr/employment/${userId}`, {
        jobTitle,
        employmentType,
        effectiveFrom,
        salary: salary ? Number(salary) : null,
        changeReason: changeReason || null,
      }),
    { invalidates: ['/hr/employment', '/users'], onSuccess: onClose },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="employment-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="employment-title">Record a change of terms</h3>
        <p className="field-hint">
          The current record is closed the day before this one starts. Existing terms
          cannot be back-dated over — that is a correction, and it should be visible as one.
        </p>
        <FormError error={record.error} />
        <form onSubmit={(e) => { e.preventDefault(); void record.mutate(); }}>
          <div className="field">
            <label htmlFor="emp-title">Job title</label>
            <input id="emp-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required autoFocus />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="emp-type">Type</label>
              <select id="emp-type" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
                {['permanent', 'fixed_term', 'contractor', 'intern', 'part_time'].map((t) => (
                  <option key={t} value={t}>{titleCase(t.replace('_', ' '))}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="emp-from">Effective from</label>
              <input id="emp-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
            </div>
          </div>
          {can('hr.compensation') ? (
            <div className="field">
              <label htmlFor="emp-salary">Salary</label>
              <input id="emp-salary" type="number" min="0" step="1" value={salary} onChange={(e) => setSalary(e.target.value)} />
              <p className="field-hint">Encrypted at rest, and never written to the audit trail.</p>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="emp-reason">Reason</label>
            <input id="emp-reason" value={changeReason} onChange={(e) => setChangeReason(e.target.value)} placeholder="Promotion" />
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={record.pending}>
              {record.pending ? 'Recording…' : 'Record change'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
