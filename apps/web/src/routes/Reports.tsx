/**
 * Reporting.
 *
 * Organised around questions rather than around the tables the answers come from. The two
 * panels at the top are the ones that cost real money if nobody looks: expenses approved
 * that nobody has paid, and equipment still out with people who have left. Everything
 * else is context.
 */
import { AlertTriangle, Banknote, Laptop, TrendingUp, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useQuery } from '../lib/query';
import { AsyncSection } from '../components/States';
import { formatCurrency, formatDate, titleCase } from '../lib/format';

type Overview = {
  headcount: {
    byStatus: { status: string; count: number }[];
    byDepartment: { department: string; count: number }[];
    activeGuests: number;
    movement: { month: string; joined: string; left_count: string }[];
  };
  approvals: {
    byStatus: { status: string; count: number }[];
    averageHoursToDecision: number | null;
    decidedLast90Days: number;
    overdue: { reference: string; title: string; waiting_on: string; days_overdue: number }[];
  };
  spend: {
    byCategory: { category: string; total: string }[];
    awaitingPayment: {
      reference: string; title: string; total_amount: string; currency: string;
      claimant_name: string; days_waiting: number;
    }[];
    budgets: { name: string; currency: string; amount: string; used_percent: string; remaining: string }[];
  };
  leave: {
    byType: { type_name: string; colour: string; days: string }[];
    upcoming: { display_name: string; type_name: string; start_date: string; end_date: string }[];
    unusedLeave: { display_name: string; type_name: string; remaining: string; entitled: string }[];
  };
  assets: {
    byStatus: { status: string; count: number }[];
    totalPurchaseValue: number;
    withDepartedStaff: { asset_tag: string; name: string; holder_name: string }[];
  };
};

const n = (v: string | number | undefined | null) => Number(v ?? 0);

/**
 * Hours, said the way a person would.
 *
 * A fast queue rounds to zero hours, which reads as broken rather than good. Below an
 * hour it is minutes, above a couple of days it is days.
 */
function formatDuration(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(Math.round(hours * 60), 1)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function Reports() {
  const report = useQuery<Overview>('/reports/overview', (signal) =>
    api.get('/reports/overview', signal),
  );

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Reports</h2>
          <p>Where the company stands, and what needs attention.</p>
        </div>
      </header>

      <AsyncSection query={report}>
        {(data) => {
          const active = n(data.headcount.byStatus.find((s) => s.status === 'active')?.count);
          const unpaid = data.spend.awaitingPayment;
          const stranded = data.assets.withDepartedStaff;
          const unpaidTotal = unpaid.reduce((sum, c) => sum + n(c.total_amount), 0);

          return (
            <>
              {/* Attention first: these two are the ones that cost money quietly. */}
              {unpaid.length > 0 || stranded.length > 0 || data.approvals.overdue.length > 0 ? (
                <section className="panel attention-panel" aria-labelledby="attention">
                  <div className="panel-header">
                    <div>
                      <AlertTriangle size={16} aria-hidden="true" />
                      <h3 id="attention">Needs attention</h3>
                    </div>
                  </div>
                  <div className="attention-grid">
                    {unpaid.length > 0 ? (
                      <div className="attention-item">
                        <strong>{formatCurrency(unpaidTotal, unpaid[0]?.currency)}</strong>
                        <span>
                          approved but unpaid across {unpaid.length} claim
                          {unpaid.length === 1 ? '' : 's'}
                        </span>
                        <ul className="attention-list">
                          {unpaid.slice(0, 5).map((claim) => (
                            <li key={claim.reference}>
                              <code>{claim.reference}</code> {claim.claimant_name} ·{' '}
                              <span className={claim.days_waiting > 14 ? 'value-warn' : ''}>
                                waiting {claim.days_waiting} days
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {stranded.length > 0 ? (
                      <div className="attention-item">
                        <strong>{stranded.length}</strong>
                        <span>item{stranded.length === 1 ? '' : 's'} of equipment with people who have left</span>
                        <ul className="attention-list">
                          {stranded.slice(0, 5).map((asset) => (
                            <li key={asset.asset_tag}>
                              <code>{asset.asset_tag}</code> {asset.name} · {asset.holder_name}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {data.approvals.overdue.length > 0 ? (
                      <div className="attention-item">
                        <strong>{data.approvals.overdue.length}</strong>
                        <span>approvals past their due date</span>
                        <ul className="attention-list">
                          {data.approvals.overdue.slice(0, 5).map((request) => (
                            <li key={request.reference}>
                              <code>{request.reference}</code> with {request.waiting_on} ·{' '}
                              <span className="value-warn">{request.days_overdue} days over</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <div className="metric-row">
                <div className="metric-card">
                  <Users size={16} aria-hidden="true" />
                  <strong>{active}</strong>
                  <span>People</span>
                  <p className="balance-breakdown">
                    {data.headcount.activeGuests} external guest
                    {data.headcount.activeGuests === 1 ? '' : 's'} with access
                  </p>
                </div>
                <div className="metric-card">
                  <TrendingUp size={16} aria-hidden="true" />
                  <strong>{formatDuration(data.approvals.averageHoursToDecision)}</strong>
                  <span>Average time to a decision</span>
                  <p className="balance-breakdown">{data.approvals.decidedLast90Days} decided in 90 days</p>
                </div>
                <div className="metric-card">
                  <Laptop size={16} aria-hidden="true" />
                  <strong>{formatCurrency(data.assets.totalPurchaseValue)}</strong>
                  <span>Equipment at cost</span>
                  <p className="balance-breakdown">
                    {data.assets.byStatus.map((s) => `${s.count} ${s.status.replace('_', ' ')}`).join(' · ')}
                  </p>
                </div>
              </div>

              <div className="operations-grid">
                <section className="panel" aria-labelledby="spend-heading">
                  <div className="panel-header">
                    <div><Banknote size={16} aria-hidden="true" /><h3 id="spend-heading">Spend by category</h3></div>
                  </div>
                  {data.spend.byCategory.length === 0 ? (
                    <p className="panel-empty">Nothing approved yet.</p>
                  ) : (
                    <BarList
                      items={data.spend.byCategory.map((c) => ({
                        label: c.category,
                        value: n(c.total),
                        display: formatCurrency(n(c.total)),
                      }))}
                    />
                  )}

                  <h4>Budgets</h4>
                  {data.spend.budgets.length === 0 ? (
                    <p className="panel-empty">No budgets running.</p>
                  ) : (
                    <ul className="budget-lines">
                      {data.spend.budgets.map((budget, i) => (
                        <li key={`${budget.name}-${i}`}>
                          <div>
                            <strong>{budget.name}</strong>
                            <span>{formatCurrency(n(budget.remaining), budget.currency)} left</span>
                          </div>
                          <span className={n(budget.used_percent) > 90 ? 'value-warn' : 'task-meta'}>
                            {budget.used_percent}% used
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="panel" aria-labelledby="people-heading">
                  <div className="panel-header">
                    <div><Users size={16} aria-hidden="true" /><h3 id="people-heading">People</h3></div>
                  </div>
                  <BarList
                    items={data.headcount.byDepartment.map((d) => ({
                      label: d.department,
                      value: n(d.count),
                      display: String(d.count),
                    }))}
                  />

                  <h4>Leave taken this year</h4>
                  {data.leave.byType.length === 0 ? (
                    <p className="panel-empty">No leave recorded.</p>
                  ) : (
                    <BarList
                      items={data.leave.byType.map((t) => ({
                        label: t.type_name,
                        value: n(t.days),
                        display: `${n(t.days)} days`,
                        colour: t.colour,
                      }))}
                    />
                  )}

                  {data.leave.unusedLeave.length > 0 ? (
                    <>
                      <h4>Barely taken any leave</h4>
                      <p className="field-hint">
                        More than sixty percent of the year's entitlement still unused — a
                        scheduling problem in December and often a signal before that.
                      </p>
                      <ul className="plain-list">
                        {data.leave.unusedLeave.slice(0, 8).map((row, i) => (
                          <li key={i}>
                            {row.display_name} · {n(row.remaining)} of {n(row.entitled)} days left
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </section>
              </div>

              {data.leave.upcoming.length > 0 ? (
                <section className="panel" aria-labelledby="away-heading">
                  <h3 id="away-heading">Away in the next month</h3>
                  <ul className="plain-list">
                    {data.leave.upcoming.map((row, i) => (
                      <li key={i}>
                        <strong>{row.display_name}</strong> — {row.type_name},{' '}
                        {formatDate(row.start_date)}
                        {row.start_date !== row.end_date ? ` to ${formatDate(row.end_date)}` : ''}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

/**
 * A horizontal bar list rather than a chart library.
 *
 * These are all "how does this compare to that" questions with a handful of rows, which a
 * bar answers directly and legibly - and it costs no dependency, renders identically in
 * both themes, and stays readable at 390px where a chart would not.
 */
function BarList({
  items,
}: {
  items: { label: string; value: number; display: string; colour?: string }[];
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="bar-list">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`}>
          <span className="bar-label">{titleCase(item.label)}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{
                width: `${Math.max((item.value / max) * 100, 2)}%`,
                background: item.colour ?? 'var(--a-600)',
              }}
            />
          </span>
          <span className="bar-value">{item.display}</span>
        </li>
      ))}
    </ul>
  );
}
