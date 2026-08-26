/**
 * Administration console (blueprint 04/15).
 *
 * Operational health, company settings, groups and the audit trail. Every panel here is
 * capability-gated on the server; the UI simply avoids showing controls that would be
 * refused.
 */
import { useState } from 'react';
import { Activity, Database, Download, ScrollText, Users2 } from 'lucide-react';
import { api, API_URL, type Paged } from '../lib/api';
import { useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading } from '../components/States';
import { formatDateTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Operations = {
  queue: { pending: number; oldestSeconds: number };
  deadLetters: number;
  mailFailures24h: number;
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

type Tab = 'operations' | 'audit' | 'groups';

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
                <div>
                  <dt>Mail failures (24h)</dt>
                  <dd className={operations.data.mailFailures24h > 0 ? 'value-warn' : ''}>
                    {operations.data.mailFailures24h}
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
                      <span className="status-tag">{group.member_count} members</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>
      ) : null}
    </div>
  );
}
