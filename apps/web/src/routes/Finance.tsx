/**
 * Expenses, budgets, vendors and the asset register.
 *
 * One module with tabs rather than four navigation entries: these are the same job seen
 * from different distances, and only the claims tab is used by everyone. Each tab is
 * gated on its own capability, so most people see one and finance sees four.
 */
import { useMemo, useState } from 'react';
import { Laptop, Paperclip, Plus, Receipt, Trash2, Wallet } from 'lucide-react';
import { api, idempotencyKey } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, FormError } from '../components/States';
import { formatCurrency, formatDate, initials, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import { Invoices } from '../components/Invoices';
import { Quotations } from '../components/Quotations';
import { uploadWorkspaceFile } from '../lib/uploads';
import { RecordEditor } from '../components/RecordEditor';

type Tab = 'quotations' | 'invoices' | 'claims' | 'budgets' | 'assets' | 'vendors';

type Claim = {
  id: string;
  reference: string;
  title: string;
  currency: string;
  total_amount: string;
  status: string;
  claimant_name: string;
  item_count: number;
  payment_reference: string | null;
  created_at: string;
};

type Category = { id: string; name: string; requires_receipt_above: string; limit_amount: string | null
  key: string;
  active: boolean;
};
type Budget = {
  id: string;
  name: string;
  department_name: string | null;
  currency: string;
  amount: string;
  committed_amount: string;
  spent_amount: string;
  remaining_amount: string;
  period_start: string;
  period_end: string;
};
type Asset = {
  id: string;
  asset_tag: string;
  name: string;
  category: string;
  serial_number: string | null;
  status: string;
  assignee_name: string | null;
  assigned_to: string | null;
};
type Vendor = { id: string; name: string; contact_email: string | null; organization_name: string | null };

const num = (v: string | number) => Number(v ?? 0);

export default function Finance() {
  const { can } = useSession();
  const tabs = (
    [
      // Quotations first: work is quoted before it is invoiced.
      ['quotations', 'Quotations', can('quotation.read')],
      ['invoices', 'Invoices', can('invoice.read')],
      ['claims', 'Expenses', can('expense.submit')],
      ['budgets', 'Budgets', can('budget.read')],
      ['assets', 'Assets', can('asset.read')],
      ['vendors', 'Vendors', can('vendor.manage')],
    ] as [Tab, string, boolean][]
  ).filter(([, , allowed]) => allowed);

  const [tab, setTab] = useState<Tab>(tabs[0]?.[0] ?? 'claims');

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Finance</h2>
          <p>Invoices, payments, expense claims, budgets, suppliers and equipment.</p>
        </div>
      </header>

      <div className="tab-row" role="tablist" aria-label="Finance sections">
        {tabs.map(([value, label]) => (
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

      {tab === 'quotations' ? <Quotations /> : null}
      {tab === 'invoices' ? <Invoices /> : null}
      {tab === 'claims' ? <Claims /> : null}
      {tab === 'budgets' ? <Budgets /> : null}
      {tab === 'assets' ? <Assets /> : null}
      {tab === 'vendors' ? <Vendors /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ expenses

function Claims() {
  const { can } = useSession();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [creating, setCreating] = useState(false);
  const [openClaim, setOpenClaim] = useState<string | null>(null);

  const key = `/expenses/claims?scope=${scope}`;
  const claims = useQuery<{ items: Claim[] }>(key, (signal) => api.get(key, signal));

  return (
    <>
      <div className="panel-header">
        <div className="header-controls">
          {can('expense.read_all') ? (
            <>
              <label className="visually-hidden" htmlFor="claim-scope">Whose claims</label>
              <select id="claim-scope" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')}>
                <option value="mine">My claims</option>
                <option value="all">Everyone's claims</option>
              </select>
            </>
          ) : null}
        </div>
        <button type="button" className="primary-button" onClick={() => setCreating(true)}>
          <Receipt size={15} aria-hidden="true" /> New claim
        </button>
      </div>

      <section className="panel" aria-label="Expense claims">
        <AsyncSection query={claims}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty title="No claims" description="Anything you pay for and want back goes here." />
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">What for</th>
                      {scope === 'all' ? <th scope="col">Who</th> : null}
                      <th scope="col">Amount</th>
                      <th scope="col">Status</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((claim) => (
                      <tr key={claim.id}>
                        <th scope="row"><code>{claim.reference}</code></th>
                        <td>
                          {claim.title}
                          <span className="task-meta"> · {claim.item_count} line{num(claim.item_count) === 1 ? '' : 's'}</span>
                        </td>
                        {scope === 'all' ? <td>{claim.claimant_name}</td> : null}
                        <td>{formatCurrency(num(claim.total_amount), claim.currency)}</td>
                        <td>
                          <span className={`status-tag status-${claim.status}`}>{titleCase(claim.status)}</span>
                          {claim.payment_reference ? (
                            <span className="task-meta"> {claim.payment_reference}</span>
                          ) : null}
                        </td>
                        <td className="table-actions">
                          <button type="button" className="ghost-button" onClick={() => setOpenClaim(claim.id)}>
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </AsyncSection>
      </section>

      {creating ? <ClaimDialog onClose={() => setCreating(false)} /> : null}
      {openClaim ? <ClaimDetail claimId={openClaim} onClose={() => setOpenClaim(null)} /> : null}
    </>
  );
}

function ClaimDialog({ onClose }: { onClose: () => void }) {
  const categories = useQuery<{ items: Category[] }>('/expenses/categories', (signal) =>
    api.get('/expenses/categories', signal),
  );
  const budgets = useQuery<{ items: Budget[] }>('/budgets', (signal) => api.get('/budgets', signal));

  const [title, setTitle] = useState('');
  const [budgetId, setBudgetId] = useState('');
  const [lines, setLines] = useState<Line[]>([
    { categoryId: '', spentOn: '', merchant: '', description: '', amount: '', taxAmount: '', receiptFileId: null, receiptName: null },
  ]);
  const key = useMemo(() => idempotencyKey(), []);

  const create = useMutation(
    async () =>
      api.post<Claim>(
        '/expenses/claims',
        {
          title,
          budgetId: budgetId || null,
          items: lines.map((line) => ({
            categoryId: line.categoryId || null,
            spentOn: line.spentOn,
            merchant: line.merchant || null,
            description: line.description || null,
            amount: Number(line.amount || 0),
            taxAmount: Number(line.taxAmount || 0),
            receiptFileId: line.receiptFileId,
          })),
        },
        { idempotencyKey: key },
      ),
    {
      invalidates: ['/expenses/claims'],
      onSuccess: onClose,
    },
  );

  // Shown as you type so the number is never a surprise at the end.
  const total = lines.reduce((sum, l) => sum + Number(l.amount || 0) + Number(l.taxAmount || 0), 0);

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="claim-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="claim-title">New expense claim</h3>
        <FormError error={create.error} />

        <form onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
          <div className="field">
            <label htmlFor="claim-name">What is this for?</label>
            <input id="claim-name" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder="Client visit to Kandy" />
          </div>

          <div className="field">
            <label htmlFor="claim-budget">Budget (optional)</label>
            <select id="claim-budget" value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
              <option value="">Not against a budget</option>
              {(budgets.data?.items ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <h4>Lines</h4>
          {lines.map((line, index) => (
            <div className="claim-line" key={index}>
              <div className="field">
                <label htmlFor={`line-date-${index}`}>Date</label>
                <input id={`line-date-${index}`} type="date" value={line.spentOn}
                  onChange={(e) => setLines(lines.map((l, i) => i === index ? { ...l, spentOn: e.target.value } : l))} required />
              </div>
              <div className="field">
                <label htmlFor={`line-cat-${index}`}>Category</label>
                <select id={`line-cat-${index}`} value={line.categoryId}
                  onChange={(e) => setLines(lines.map((l, i) => i === index ? { ...l, categoryId: e.target.value } : l))}>
                  <option value="">Uncategorised</option>
                  {(categories.data?.items ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`line-merchant-${index}`}>Merchant</label>
                <input id={`line-merchant-${index}`} value={line.merchant}
                  onChange={(e) => setLines(lines.map((l, i) => i === index ? { ...l, merchant: e.target.value } : l))} />
              </div>
              <div className="field">
                <label htmlFor={`line-amount-${index}`}>Amount</label>
                <input id={`line-amount-${index}`} type="number" min="0" step="0.01" value={line.amount}
                  onChange={(e) => setLines(lines.map((l, i) => i === index ? { ...l, amount: e.target.value } : l))} required />
              </div>
              <div className="field">
                <label htmlFor={`line-tax-${index}`}>Tax</label>
                <input id={`line-tax-${index}`} type="number" min="0" step="0.01" value={line.taxAmount}
                  onChange={(e) => setLines(lines.map((l, i) => i === index ? { ...l, taxAmount: e.target.value } : l))} />
              </div>
              <ReceiptControl
                index={index}
                line={line}
                onUploaded={(fileId, fileName) =>
                  setLines(lines.map((l, i) => i === index ? { ...l, receiptFileId: fileId, receiptName: fileName } : l))
                }
              />
              {lines.length > 1 ? (
                <button type="button" className="icon-button" aria-label={`Remove line ${index + 1}`}
                  onClick={() => setLines(lines.filter((_, i) => i !== index))}>
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          ))}

          <button type="button" className="ghost-button"
            onClick={() => setLines([...lines, { categoryId: '', spentOn: '', merchant: '', description: '', amount: '', taxAmount: '', receiptFileId: null, receiptName: null }])}>
            <Plus size={14} aria-hidden="true" /> Add line
          </button>

          <p className="claim-total">Total <strong>{formatCurrency(total)}</strong></p>
          <p className="field-hint">
            The total is worked out from the lines when you save, so this is a preview
            rather than the figure itself.
          </p>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending || !title.trim()}>
              {create.pending ? 'Saving…' : 'Save draft'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ClaimDetail({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const { can, session } = useSession();
  const [paymentReference, setPaymentReference] = useState('');
  const claim = useQuery<Claim & { items: Record<string, string>[]; claimant_id: string }>(
    `/expenses/claims/${claimId}`,
    (signal) => api.get(`/expenses/claims/${claimId}`, signal),
  );

  // Both actions finish the job the dialog exists for, so it closes rather than sitting
  // there showing a state that is no longer true with a button that would now fail.
  const submit = useMutation(
    async () => api.post(`/expenses/claims/${claimId}/submit`, {}, { idempotencyKey: idempotencyKey() }),
    { invalidates: ['/expenses/claims', '/approvals'], onSuccess: onClose },
  );
  const reimburse = useMutation(
    async () =>
      api.post(`/expenses/claims/${claimId}/reimburse`, { paymentReference }, { idempotencyKey: idempotencyKey() }),
    { invalidates: ['/expenses/claims', '/budgets'], onSuccess: onClose },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="claim-detail" onClick={(e) => e.stopPropagation()}>
        <AsyncSection query={claim}>
          {(data) => (
            <>
              <h3 id="claim-detail">{data.reference} — {data.title}</h3>
              <p className="request-amount">{formatCurrency(num(data.total_amount), data.currency)}</p>
              <p className="task-meta">
                <span className={`status-tag status-${data.status}`}>{titleCase(data.status)}</span>{' '}
                raised <time dateTime={data.created_at}>{relativeTime(data.created_at)}</time>
              </p>

              <h4>Lines</h4>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Category</th>
                      <th scope="col">Merchant</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Receipt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.items ?? []).map((item) => (
                      <tr key={String(item.id)}>
                        <td>{formatDate(String(item.spent_on))}</td>
                        <td>{item.category_name ?? '—'}</td>
                        <td>{item.merchant ?? '—'}</td>
                        <td>{formatCurrency(num(item.amount) + num(item.tax_amount), data.currency)}</td>
                        <td>{item.receipt_name ?? <span className="task-meta">none</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <FormError error={submit.error} />
              <FormError error={reimburse.error} />

              {data.status === 'draft' && data.claimant_id === session?.user?.id ? (
                <div className="dialog-actions">
                  <button type="button" className="ghost-button" onClick={onClose}>Close</button>
                  <button type="button" className="primary-button" disabled={submit.pending}
                    onClick={() => void submit.mutate()}>
                    {submit.pending ? 'Submitting…' : 'Submit for approval'}
                  </button>
                </div>
              ) : data.status === 'approved' && can('expense.reimburse') ? (
                <>
                  <h4>Record payment</h4>
                  <div className="field">
                    <label htmlFor="payment-ref">Payment reference</label>
                    <input id="payment-ref" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="BACS-99812" />
                    <p className="field-hint">
                      Whoever approved this claim cannot also record its payment.
                    </p>
                  </div>
                  <div className="dialog-actions">
                    <button type="button" className="ghost-button" onClick={onClose}>Close</button>
                    <button type="button" className="primary-button" disabled={reimburse.pending || !paymentReference.trim()}
                      onClick={() => void reimburse.mutate()}>
                      {reimburse.pending ? 'Recording…' : 'Mark as paid'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="dialog-actions">
                  <button type="button" className="primary-button" onClick={onClose}>Close</button>
                </div>
              )}
            </>
          )}
        </AsyncSection>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ budgets

function Budgets() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const budgets = useQuery<{ items: Budget[] }>('/budgets', (signal) => api.get('/budgets', signal));

  return (
    <>
      {can('budget.manage') ? (
        <div className="panel-header">
          <div />
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Wallet size={15} aria-hidden="true" /> New budget
          </button>
        </div>
      ) : null}

      <AsyncSection query={budgets}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty title="No budgets" description="A budget lets claims be counted against something." />
          ) : (
            <div className="metric-row">
              {data.items.map((budget) => {
                const total = num(budget.amount);
                const spent = num(budget.spent_amount);
                const committed = num(budget.committed_amount);
                const spentPct = total > 0 ? (spent / total) * 100 : 0;
                const committedPct = total > 0 ? (committed / total) * 100 : 0;
                const over = spent + committed > total;
                return (
                  <div className="metric-card budget-card" key={budget.id}>
                    <strong>{formatCurrency(num(budget.remaining_amount), budget.currency)}</strong>
                    <span>{budget.name} left</span>
                    {/* Committed sits alongside spent because money promised is money
                        gone for planning purposes, even before it clears. */}
                    <div className="budget-bar" role="presentation">
                      <span className="budget-spent" style={{ width: `${Math.min(spentPct, 100)}%` }} />
                      <span className="budget-committed" style={{ width: `${Math.min(committedPct, 100 - Math.min(spentPct, 100))}%` }} />
                    </div>
                    <p className="balance-breakdown">
                      {formatCurrency(spent, budget.currency)} spent · {formatCurrency(committed, budget.currency)} committed
                      {' · '}{formatCurrency(total, budget.currency)} total
                      {budget.department_name ? ` · ${budget.department_name}` : ''}
                    </p>
                    {over ? <span className="status-tag status-suspended">Over budget</span> : null}
                    {can('budget.manage') ? (
                      <div className="table-actions">
                        <button type="button" className="ghost-button" onClick={() => setEditingBudget(budget)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={async () => {
                            await api.delete(`/budgets/${budget.id}`);
                            invalidate('/budgets');
                            budgets.reload();
                          }}
                        >
                          Close
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )
        }
      </AsyncSection>

      {editingBudget ? (
        <RecordEditor
          title={`Edit ${editingBudget.name}`}
          path={`/budgets/${editingBudget.id}`}
          savedMessage="Budget updated"
          initial={editingBudget as unknown as Record<string, unknown>}
          fields={[
            { name: 'name', label: 'Name', required: true },
            {
              name: 'amount', label: 'Amount', type: 'number',
              // Spent and committed are derived from claims, so they are not editable
              // here — a hand-set total would disagree with the claims behind it.
              hint: 'Cannot be set below what has already been spent.',
            },
            { name: 'periodStart', label: 'Period starts', type: 'date' },
            { name: 'periodEnd', label: 'Period ends', type: 'date' },
          ]}
          onClose={() => setEditingBudget(null)}
          onSaved={() => { setEditingBudget(null); invalidate('/budgets'); budgets.reload(); }}
        />
      ) : null}

      {/* Categories live with budgets: both are budget.manage, and a category with the
          wrong limit is a budgeting problem rather than a claims one. */}
      {can('budget.manage') ? <ExpenseCategories /> : null}

      {creating ? <BudgetDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function BudgetDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [amount, setAmount] = useState('');

  const create = useMutation(
    async () => api.post('/budgets', { name, periodStart, periodEnd, amount: Number(amount) }),
    { invalidates: ['/budgets'], onSuccess: onClose },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="budget-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="budget-title">New budget</h3>
        <FormError error={create.error} />
        <form onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
          <div className="field">
            <label htmlFor="budget-name">Name</label>
            <input id="budget-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Engineering 2026" />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="budget-start">From</label>
              <input id="budget-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="budget-end">To</label>
              <input id="budget-end" type="date" value={periodEnd} min={periodStart || undefined} onChange={(e) => setPeriodEnd(e.target.value)} required />
            </div>
          </div>
          <div className="field">
            <label htmlFor="budget-amount">Amount</label>
            <input id="budget-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create budget'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ assets

function Assets() {
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<Asset | null>(null);

  const key = `/assets${search ? `?q=${encodeURIComponent(search)}` : ''}`;
  const assets = useQuery<{ items: Asset[] }>(key, (signal) => api.get(key, signal));

  return (
    <>
      <div className="panel-header">
        <div className="header-controls">
          <label className="visually-hidden" htmlFor="asset-search">Search equipment</label>
          <input id="asset-search" type="search" value={search} placeholder="Tag, name or serial"
            onChange={(e) => setSearch(e.target.value)} />
        </div>
        {can('asset.manage') ? (
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Laptop size={15} aria-hidden="true" /> Add equipment
          </button>
        ) : null}
      </div>

      <section className="panel" aria-label="Equipment">
        <AsyncSection query={assets}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty title="Nothing registered" description="Laptops, phones and anything else worth tracking." />
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Tag</th>
                      <th scope="col">Item</th>
                      <th scope="col">Serial</th>
                      <th scope="col">Status</th>
                      <th scope="col">Held by</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((asset) => (
                      <tr key={asset.id}>
                        <th scope="row"><code>{asset.asset_tag}</code></th>
                        <td>{asset.name}<span className="task-meta"> · {titleCase(asset.category)}</span></td>
                        <td><code className="asset-serial">{asset.serial_number ?? '—'}</code></td>
                        <td><span className={`status-tag status-${asset.status}`}>{titleCase(asset.status.replace('_', ' '))}</span></td>
                        <td>{asset.assignee_name ?? <span className="task-meta">—</span>}</td>
                        <td className="table-actions">
                          {can('asset.manage') ? (
                            <>
                              <button type="button" className="ghost-button" onClick={() => setEditingAsset(asset)}>
                                Edit
                              </button>
                              <button type="button" className="ghost-button" onClick={() => setAssigning(asset)}>
                                {asset.assigned_to ? 'Reassign' : 'Assign'}
                              </button>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </AsyncSection>
      </section>

      {creating ? <AssetDialog onClose={() => setCreating(false)} /> : null}
      {editingAsset ? (
        <RecordEditor
          title={`Edit ${editingAsset.name}`}
          path={`/assets/${editingAsset.id}`}
          savedMessage="Asset updated"
          initial={editingAsset as unknown as Record<string, unknown>}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'category', label: 'Category' },
            { name: 'serialNumber', label: 'Serial number' },
            { name: 'location', label: 'Location' },
            { name: 'purchaseCost', label: 'Purchase cost', type: 'number' },
            { name: 'warrantyUntil', label: 'Warranty until', type: 'date' },
            { name: 'notes', label: 'Notes', type: 'textarea' },
            {
              name: 'status', label: 'Status', type: 'select',
              hint: 'An asset still held by someone cannot be retired.',
              options: [
                { value: 'in_stock', label: 'In stock' },
                { value: 'assigned', label: 'Assigned' },
                { value: 'repair', label: 'In repair' },
                { value: 'retired', label: 'Retired' },
              ],
            },
          ]}
          onClose={() => setEditingAsset(null)}
          onSaved={() => { setEditingAsset(null); invalidate('/assets'); }}
        />
      ) : null}

      {assigning ? <AssignDialog asset={assigning} onClose={() => setAssigning(null)} /> : null}
    </>
  );
}

function AssetDialog({ onClose }: { onClose: () => void }) {
  const [assetTag, setAssetTag] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('laptop');
  const [serialNumber, setSerialNumber] = useState('');
  const [purchaseCost, setPurchaseCost] = useState('');

  const create = useMutation(
    async () =>
      api.post('/assets', {
        assetTag,
        name,
        category,
        serialNumber: serialNumber || null,
        purchaseCost: purchaseCost ? Number(purchaseCost) : null,
      }),
    { invalidates: ['/assets'], onSuccess: onClose },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="asset-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="asset-title">Add equipment</h3>
        <FormError error={create.error} />
        <form onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="asset-tag">Asset tag</label>
              <input id="asset-tag" value={assetTag} onChange={(e) => setAssetTag(e.target.value)} required autoFocus placeholder="IW-0142" />
            </div>
            <div className="field">
              <label htmlFor="asset-category">Category</label>
              <select id="asset-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                {['laptop', 'phone', 'monitor', 'peripheral', 'furniture', 'other'].map((c) => (
                  <option key={c} value={c}>{titleCase(c)}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="asset-name">Item</label>
            <input id="asset-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="MacBook Pro 14" />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="asset-serial">Serial number</label>
              <input id="asset-serial" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="asset-cost">Purchase cost</label>
              <input id="asset-cost" type="number" min="0" step="0.01" value={purchaseCost} onChange={(e) => setPurchaseCost(e.target.value)} />
            </div>
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Adding…' : 'Add equipment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AssignDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [userId, setUserId] = useState(asset.assigned_to ?? '');
  const [conditionNote, setConditionNote] = useState('');
  const people = useQuery<{ items: { id: string; displayName: string }[] }>(
    '/users?limit=100&status=active',
    (signal) => api.get('/users?limit=100&status=active', signal),
  );
  const history = useQuery<{ items: Record<string, string>[] }>(
    `/assets/${asset.id}/history`,
    (signal) => api.get(`/assets/${asset.id}/history`, signal),
  );

  const assign = useMutation(
    async () => api.post(`/assets/${asset.id}/assign`, { userId: userId || null, conditionNote: conditionNote || null }),
    { invalidates: ['/assets'], onSuccess: onClose },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="assign-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="assign-title">{asset.asset_tag} — {asset.name}</h3>
        <FormError error={assign.error} />
        <form onSubmit={(e) => { e.preventDefault(); void assign.mutate(); }}>
          <div className="field">
            <label htmlFor="assign-to">Held by</label>
            <select id="assign-to" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Nobody — back in stock</option>
              {(people.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="assign-note">Condition</label>
            <input id="assign-note" value={conditionNote} onChange={(e) => setConditionNote(e.target.value)} placeholder="New, boxed" />
          </div>

          <h4>Previously</h4>
          <AsyncSection query={history}>
            {(data) =>
              data.items.length === 0 ? (
                <p className="panel-empty">Never assigned.</p>
              ) : (
                <ul className="assignment-list">
                  {data.items.map((entry, i) => (
                    <li key={i}>
                      <strong>{entry.holder_name ?? 'Unassigned'}</strong>
                      <span>
                        {formatDate(String(entry.assigned_at))}
                        {entry.returned_at ? ` – ${formatDate(String(entry.returned_at))}` : ' – now'}
                        {entry.condition_note ? ` · ${entry.condition_note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={assign.pending}>
              {assign.pending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ vendors

function Vendors() {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const vendors = useQuery<{ items: Vendor[] }>('/vendors', (signal) => api.get('/vendors', signal));

  const create = useMutation(
    async (name: string) => api.post('/vendors', { name }),
    { invalidates: ['/vendors'], onSuccess: () => setCreating(false) },
  );
  const [name, setName] = useState('');

  return (
    <>
      <div className="panel-header">
        <div />
        <button type="button" className="primary-button" onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden="true" /> Add supplier
        </button>
      </div>

      <section className="panel" aria-label="Suppliers">
        <AsyncSection query={vendors}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty title="No suppliers" description="Companies you buy from." />
            ) : (
              <ul className="person-list">
                {data.items.map((vendor) => (
                  <li key={vendor.id}>
                    <div className="person-row">
                      <span className="person-avatar" aria-hidden="true">{initials(vendor.name)}</span>
                      <span className="person-body">
                        <strong>{vendor.name}</strong>
                        <span>
                          {vendor.contact_email ?? 'No contact recorded'}
                          {vendor.organization_name ? ` · linked to ${vendor.organization_name}` : ''}
                        </span>
                      </span>
                      <span className="table-actions">
                        <button type="button" className="ghost-button" onClick={() => setEditing(vendor)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={async () => {
                            // Archive, not delete: assets record which supplier they came
                            // from, and removing the row would erase that history.
                            await api.delete(`/vendors/${vendor.id}`);
                            invalidate('/vendors');
                            vendors.reload();
                          }}
                        >
                          Archive
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncSection>
      </section>

      {editing ? (
        <RecordEditor
          title={`Edit ${editing.name}`}
          path={`/vendors/${editing.id}`}
          savedMessage="Supplier updated"
          initial={editing as unknown as Record<string, unknown>}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'contactEmail', label: 'Contact email', type: 'email' },
            { name: 'contactPhone', label: 'Phone' },
            { name: 'taxId', label: 'Tax ID' },
            { name: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate('/vendors'); vendors.reload(); }}
        />
      ) : null}

      {creating ? (
        <div className="dialog-scrim" role="presentation" onClick={() => setCreating(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="vendor-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="vendor-title">Add supplier</h3>
            <FormError error={create.error} />
            <form onSubmit={(e) => { e.preventDefault(); void create.mutate(name); }}>
              <div className="field">
                <label htmlFor="vendor-name">Name</label>
                <input id="vendor-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </div>
              <div className="dialog-actions">
                <button type="button" className="ghost-button" onClick={() => setCreating(false)}>Cancel</button>
                <button type="submit" className="primary-button" disabled={create.pending}>Add</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

type Line = {
  categoryId: string;
  spentOn: string;
  merchant: string;
  description: string;
  amount: string;
  taxAmount: string;
  receiptFileId: string | null;
  receiptName: string | null;
};

/**
 * Attaches a receipt to one line of a claim.
 *
 * The receipt goes through the ordinary file pipeline rather than a side channel, so it
 * is scanned for malware, versioned and retained like anything else - a photograph of a
 * receipt is still an upload from a phone, and the fact that finance asked for it does
 * not make it safe.
 *
 * Categories can require a receipt above a threshold, and that rule is enforced on the
 * server when the claim is saved. Without somewhere to attach one, that rule was a wall
 * with no door.
 */
function ReceiptControl({
  index,
  line,
  onUploaded,
}: {
  index: number;
  line: Line;
  onUploaded: (fileId: string, fileName: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const stored = await uploadWorkspaceFile<{ id: string; name: string }>(file);
      onUploaded(stored.id, stored.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That receipt could not be attached');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field receipt-field">
      <label htmlFor={`line-receipt-${index}`}>Receipt</label>
      {line.receiptFileId ? (
        <span className="receipt-attached" title={line.receiptName ?? undefined}>
          <Paperclip size={13} aria-hidden="true" />
          {line.receiptName}
        </span>
      ) : (
        <>
          <input
            id={`line-receipt-${index}`}
            type="file"
            className="receipt-input"
            accept="image/*,application/pdf"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {busy ? <span className="task-meta">Uploading…</span> : null}
        </>
      )}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
  );
}


/**
 * Expense categories.
 *
 * The key is immutable, as it is for a leave type: existing claims refer to the category
 * by it, and re-keying would detach a year of expenses from what they were filed under.
 * Categories are deactivated rather than deleted for the same reason.
 */
function ExpenseCategories() {
  const [editing, setEditing] = useState<Category | null>(null);
  const categories = useQuery<{ items: Category[] }>('/expenses/categories', (signal) =>
    api.get('/expenses/categories', signal),
  );

  return (
    <section className="panel" aria-labelledby="categories-heading">
      <header className="panel-header">
        <span className="panel-title" id="categories-heading">Expense categories</span>
      </header>
      <AsyncSection query={categories}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="field-hint">None configured.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Name</th><th>Key</th><th>Limit</th><th>Receipt above</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {data.items.map((category) => (
                    <tr key={category.id}>
                      <td><strong>{category.name}</strong></td>
                      <td><code>{category.key}</code></td>
                      <td>{category.limit_amount ? num(category.limit_amount).toFixed(2) : '—'}</td>
                      <td>{num(category.requires_receipt_above).toFixed(2)}</td>
                      <td>
                        <span className={`status-tag ${category.active ? 'status-active' : 'status-suspended'}`}>
                          {category.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="table-actions">
                        <button type="button" className="ghost-button" onClick={() => setEditing(category)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </AsyncSection>

      {editing ? (
        <RecordEditor
          title={`Edit ${editing.name}`}
          path={`/expenses/categories/${editing.id}`}
          savedMessage="Category updated"
          initial={editing as unknown as Record<string, unknown>}
          fields={[
            { name: 'name', label: 'Name', required: true },
            { name: 'limitAmount', label: 'Per-claim limit', type: 'number',
              hint: 'Leave empty for no limit.' },
            { name: 'requiresReceiptAbove', label: 'Receipt required above', type: 'number' },
            {
              name: 'active', label: 'Status', type: 'select',
              hint: 'Inactive categories leave the picker; existing claims keep theirs.',
              options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
            },
          ]}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate('/expenses/categories'); categories.reload(); }}
        />
      ) : null}
    </section>
  );
}
