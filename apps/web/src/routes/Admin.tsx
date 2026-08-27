/**
 * Administration console (blueprint 04/15).
 *
 * Operational health, company settings, groups and the audit trail. Every panel here is
 * capability-gated on the server; the UI simply avoids showing controls that would be
 * refused.
 */
import { useState } from 'react';
import { Activity, Building2, Database, Download, Plus, ScrollText, Users2 } from 'lucide-react';
import { api, API_URL, type Paged } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading } from '../components/States';
import { formatDateTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Operations = {
  queue: { pending: number; oldestSeconds: number };
  deadLetters: number;
  users: { active: number; invited: number; suspended: number };
  activeSessions: number;
  realtime: { connections: number; channels: number };
  providers: Record<string, string>;
  retention: Record<string, number>;
};

type AuditEvent = {
  id: number;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  result: string;
  ip: string | null;
  correlation_id: string | null;
  created_at: string;
};

type Group = { id: string; name: string; description: string | null; member_count: number };

type Company = {
  id: string;
  name: string;
  legal_name: string | null;
  verified_domains: string[];
  region: string;
  status: string;
  settings: Record<string, unknown>;
};

type Person = { id: string; displayName: string; email: string };

type Tab = 'operations' | 'audit' | 'groups' | 'company';

export default function Admin() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('operations');
  const [actionFilter, setActionFilter] = useState('');

  const operations = useQuery<Operations>('/admin/operations', (signal) =>
    api.get('/admin/operations', signal),
  );

  const auditKey = `/audit/events?limit=50${actionFilter ? `&action=${encodeURIComponent(actionFilter)}` : ''}`;
  const audit = useQuery<Paged<AuditEvent>>(
    tab === 'audit' && can('audit.read') ? auditKey : null,
    (signal) => api.get(auditKey, signal),
  );

  const groups = useQuery<{ items: Group[] }>(
    tab === 'groups' ? '/admin/groups' : null,
    (signal) => api.get('/admin/groups', signal),
  );

  const company = useQuery<Company>(
    tab === 'company' ? '/admin/company' : null,
    (signal) => api.get('/admin/company', signal),
  );

  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Administration</h2>
          <p>Operational health, access groups and the audit trail.</p>
        </div>
      </header>

      <div className="tab-row" role="tablist" aria-label="Administration sections">
        {(
          [
            ['operations', 'Operations', true],
            ['audit', 'Audit trail', can('audit.read')],
            ['groups', 'Groups', can('user.read')],
            ['company', 'Company', can('settings.read')],
          ] as [Tab, string, boolean][]
        )
          .filter(([, , allowed]) => allowed)
          .map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`tab ${tab === value ? 'tab-active' : ''}`}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
      </div>

      {tab === 'operations' ? (
        operations.loading ? (
          <Loading label="Loading operational health" rows={4} />
        ) : operations.error ? (
          <ErrorState error={operations.error} onRetry={operations.reload} />
        ) : operations.data ? (
          <div className="operations-grid">
            <section className="panel">
              <header className="panel-header">
                <div>
                  <Activity size={16} aria-hidden="true" />
                  <h3>Background work</h3>
                </div>
              </header>
              <dl className="detail-list">
                <div>
                  <dt>Pending events</dt>
                  <dd>{operations.data.queue.pending}</dd>
                </div>
                <div>
                  <dt>Oldest waiting</dt>
                  <dd>{operations.data.queue.oldestSeconds}s</dd>
                </div>
                <div>
                  <dt>Dead letters (7 days)</dt>
                  <dd className={operations.data.deadLetters > 0 ? 'value-warn' : ''}>
                    {operations.data.deadLetters}
                  </dd>
                </div>
              </dl>
              {operations.data.queue.oldestSeconds > 300 ? (
                <p className="field-error" role="alert">
                  The event queue is falling behind. Check worker health.
                </p>
              ) : null}
            </section>

            <section className="panel">
              <header className="panel-header">
                <div>
                  <Users2 size={16} aria-hidden="true" />
                  <h3>Accounts</h3>
                </div>
              </header>
              <dl className="detail-list">
                <div><dt>Active</dt><dd>{operations.data.users.active}</dd></div>
                <div><dt>Invited</dt><dd>{operations.data.users.invited}</dd></div>
                <div><dt>Suspended</dt><dd>{operations.data.users.suspended}</dd></div>
                <div><dt>Live sessions</dt><dd>{operations.data.activeSessions}</dd></div>
                <div>
                  <dt>Realtime connections</dt>
                  <dd>{operations.data.realtime.connections}</dd>
                </div>
              </dl>
            </section>

            <section className="panel">
              <header className="panel-header">
                <div>
                  <Database size={16} aria-hidden="true" />
                  <h3>Providers</h3>
                </div>
              </header>
              <dl className="detail-list">
                {Object.entries(operations.data.providers).map(([name, value]) => (
                  <div key={name}>
                    <dt>{titleCase(name)}</dt>
                    <dd className={value === 'not configured' || value === 'log' ? 'value-warn' : ''}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="field-hint">
                Providers reading “log” or “not configured” are development placeholders and
                must be set before production use.
              </p>
            </section>

            <section className="panel">
              <header className="panel-header">
                <div>
                  <ScrollText size={16} aria-hidden="true" />
                  <h3>Retention</h3>
                </div>
              </header>
              <dl className="detail-list">
                {Object.entries(operations.data.retention).map(([name, value]) => (
                  <div key={name}>
                    <dt>{titleCase(name.replace(/Days$/, ''))}</dt>
                    <dd>{value} days</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        ) : null
      ) : null}

      {tab === 'audit' ? (
        <section className="panel">
          <header className="panel-header">
            <div>
              <ScrollText size={16} aria-hidden="true" />
              <h3>Audit trail</h3>
            </div>
            <a
              className="ghost-button"
              href={`${API_URL}/api/v1/audit/export?from=${new Date(
                Date.now() - 30 * 86_400_000,
              ).toISOString()}&to=${new Date().toISOString()}`}
            >
              <Download size={14} aria-hidden="true" /> Export 30 days
            </a>
          </header>

          <div className="field">
            <label htmlFor="audit-action">Filter by action</label>
            <input
              id="audit-action"
              value={actionFilter}
              placeholder="user.create"
              onChange={(event) => setActionFilter(event.target.value)}
            />
          </div>

          <AsyncSection query={audit}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty title="No matching events" />
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <caption className="visually-hidden">Audit events</caption>
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">Actor</th>
                        <th scope="col">Action</th>
                        <th scope="col">Resource</th>
                        <th scope="col">Result</th>
                        <th scope="col">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((event) => (
                        <tr key={event.id}>
                          <td>
                            <time dateTime={event.created_at}>
                              {formatDateTime(event.created_at)}
                            </time>
                          </td>
                          <td>{event.actor_email ?? 'system'}</td>
                          <th scope="row">{event.action}</th>
                          <td>{event.resource_type ?? '—'}</td>
                          <td>
                            <span className={`status-tag status-${event.result}`}>
                              {titleCase(event.result)}
                            </span>
                          </td>
                          <td>{event.ip ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </AsyncSection>
          <p className="field-hint">
            The audit trail is append-only. Reading it is itself recorded.
          </p>
        </section>
      ) : null}

      {tab === 'groups' ? (
        <section className="panel">
          <header className="panel-header">
            <div>
              <Users2 size={16} aria-hidden="true" />
              <h3>Access groups</h3>
            </div>
            {can('user.update') ? (
              <button type="button" className="primary-button" onClick={() => setCreatingGroup(true)}>
                <Plus size={15} aria-hidden="true" /> New group
              </button>
            ) : null}
          </header>
          <AsyncSection query={groups}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty
                  title="No groups yet"
                  description="Groups let you grant access to sets of people at once."
                />
              ) : (
                <ul className="group-list">
                  {data.items.map((group) => (
                    <li key={group.id}>
                      <strong>{group.name}</strong>
                      <span>{group.description ?? 'No description'}</span>
                      <span className="group-row-end">
                        <span className="status-tag">{group.member_count} members</span>
                        {can('user.update') ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setEditingGroup(group)}
                          >
                            Manage members
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>
      ) : null}

      {tab === 'company' ? (
        company.loading ? (
          <Loading label="Loading company settings" />
        ) : company.error ? (
          <ErrorState error={company.error} onRetry={company.reload} />
        ) : company.data ? (
          <CompanySettings company={company.data} onSaved={() => company.reload()} />
        ) : null
      ) : null}

      {creatingGroup ? (
        <CreateGroupDialog
          onClose={() => setCreatingGroup(false)}
          onCreated={() => {
            setCreatingGroup(false);
            invalidate('/admin/groups');
          }}
        />
      ) : null}

      {editingGroup ? (
        <GroupMembersDialog
          group={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSaved={() => {
            setEditingGroup(null);
            invalidate('/admin/groups');
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Company identity and verified domains. Adding a domain widens who can be given an
 * account, so it is a super-administrator action and requires a verified session.
 */
function CompanySettings({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const { can, session } = useSession();
  const [name, setName] = useState(company.name);
  const [legalName, setLegalName] = useState(company.legal_name ?? '');
  const [domain, setDomain] = useState('');
  const [saved, setSaved] = useState(false);

  const rename = useMutation(async () => api.patch('/admin/company', { name, legalName }), {
    invalidates: ['/admin/company'],
    onSuccess: () => {
      setSaved(true);
      onSaved();
    },
  });

  const addDomain = useMutation(async () => api.post('/admin/company/domains', { domain }), {
    invalidates: ['/admin/company'],
    onSuccess: () => {
      setDomain('');
      onSaved();
    },
  });

  const isSuperAdmin = session?.user?.accessLevel === 'super_admin';

  return (
    <div className="operations-grid">
      <section className="panel" aria-labelledby="company-heading">
        <header className="panel-header">
          <div>
            <Building2 size={16} aria-hidden="true" />
            <h3 id="company-heading">Company</h3>
          </div>
        </header>

        {rename.error ? (
          <div className="auth-error" role="alert"><p>{rename.error.message}</p></div>
        ) : null}
        {saved ? <p className="save-confirmation" role="status">Saved.</p> : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            void rename.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="company-name">Company name</label>
            <input
              id="company-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              disabled={!can('settings.update')}
            />
            <p className="field-hint">The name people see throughout the workspace.</p>
          </div>

          <div className="field">
            <label htmlFor="company-legal-name">Registered legal name</label>
            <input
              id="company-legal-name"
              value={legalName}
              onChange={(event) => setLegalName(event.target.value)}
              disabled={!can('settings.update')}
            />
            <p className="field-hint">
              Used where the registered entity matters, such as contracts and exports.
            </p>
          </div>
          {can('settings.update') ? (
            <button type="submit" className="primary-button" disabled={rename.pending}>
              {rename.pending ? 'Saving…' : 'Save'}
            </button>
          ) : null}
        </form>

        <dl className="detail-list">
          <div><dt>Region</dt><dd>{company.region}</dd></div>
          <div><dt>Status</dt><dd>{titleCase(company.status)}</dd></div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="domains-heading">
        <header className="panel-header">
          <div>
            <Database size={16} aria-hidden="true" />
            <h3 id="domains-heading">Verified domains</h3>
          </div>
        </header>

        <p className="field-hint">
          Accounts can only be created on these domains. Verify ownership in DNS before
          adding one.
        </p>

        <ul className="domain-list">
          {company.verified_domains.length === 0 ? (
            <li className="field-hint">None configured — no accounts can be created.</li>
          ) : (
            company.verified_domains.map((entry) => (
              <li key={entry}><code>{entry}</code></li>
            ))
          )}
        </ul>

        {isSuperAdmin ? (
          <>
            {addDomain.error ? (
              <div className="auth-error" role="alert">
                <p>{addDomain.error.message}</p>
                {'fields' in addDomain.error && addDomain.error.fields.length > 0 ? (
                  <ul>
                    {addDomain.error.fields.map((field) => (
                      <li key={field.field}>{field.message}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void addDomain.mutate();
              }}
            >
              <div className="field">
                <label htmlFor="new-domain">Add a domain</label>
                <input
                  id="new-domain"
                  value={domain}
                  placeholder="company.com"
                  onChange={(event) => setDomain(event.target.value)}
                  required
                />
              </div>
              <button type="submit" className="primary-button" disabled={addDomain.pending}>
                {addDomain.pending ? 'Adding…' : 'Add domain'}
              </button>
            </form>
          </>
        ) : (
          <p className="field-hint">Only a super administrator can change verified domains.</p>
        )}
      </section>
    </div>
  );
}

function CreateGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation(
    async () => api.post('/admin/groups', { name, description: description || undefined }),
    { invalidates: ['/admin/groups'], onSuccess: onCreated },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="group-title">New access group</h3>
        {create.error ? (
          <div className="auth-error" role="alert"><p>{create.error.message}</p></div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="group-name">Group name</label>
            <input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="group-description">Description</label>
            <input
              id="group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Group membership drives resource grants, so saving here invalidates authorization
 * caches server-side. The whole membership is sent as a set rather than as deltas,
 * which keeps the result predictable when two administrators edit at once.
 */
function GroupMembersDialog({
  group,
  onClose,
  onSaved,
}: {
  group: Group;
  onClose: () => void;
  onSaved: () => void;
}) {
  const people = useQuery<{ items: Person[] }>('/users?limit=200', (signal) =>
    api.get('/users?limit=200', signal),
  );
  const [selected, setSelected] = useState<string[] | null>(null);

  const save = useMutation(
    async () => api.put(`/admin/groups/${group.id}/members`, { userIds: selected ?? [] }),
    { invalidates: ['/admin/groups'], onSuccess: onSaved },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="members-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="members-title">Members of {group.name}</h3>
        <p className="field-hint">
          Changing membership takes effect immediately and refreshes what these people can
          reach.
        </p>

        {save.error ? (
          <div className="auth-error" role="alert"><p>{save.error.message}</p></div>
        ) : null}

        <AsyncSection query={people}>
          {(data) => (
            <fieldset className="field">
              <legend>People</legend>
              <div className="attendee-picker">
                {data.items.map((person) => (
                  <label key={person.id} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={(selected ?? []).includes(person.id)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const base = current ?? [];
                          return event.target.checked
                            ? [...base, person.id]
                            : base.filter((id) => id !== person.id);
                        })
                      }
                    />
                    {person.displayName}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </AsyncSection>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary-button"
            disabled={save.pending || selected === null}
            onClick={() => void save.mutate()}
          >
            {save.pending ? 'Saving…' : 'Save membership'}
          </button>
        </div>
      </div>
    </div>
  );
}
