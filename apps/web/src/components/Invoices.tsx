/**
 * Invoicing: what clients owe, what they have paid, and what is chasing them.
 *
 * The buckets across the top are the whole point of the screen. "How much is overdue"
 * is the question people open this for, so it is answered before anything is clicked.
 *
 * Money is only ever formatted here, never recalculated. Totals come from the server,
 * which computes them from the lines; a figure the browser derives is a figure that can
 * disagree with the invoice the client received.
 */
import { useMemo, useState } from 'react';
import { openDocumentPdf } from '../lib/documents-pdf';
import { api, ApiError, idempotencyKey, type Paged } from '../lib/api';
import { invalidate, useQuery } from '../lib/query';
import { useSession } from '../lib/session';
import { ErrorState, Loading } from './States';
import { useTextPrompt } from './Prompt';
import { InvoiceDocument, type BillingProfile, type InvoiceForDocument } from './InvoiceDocument';
import {
  RecordClientSignatureDialog, RequestCountersignatureDialog, SignDocumentDialog,
  nextInternalRole, useSignatureImages, type SignatureState,
} from './DocumentSigning';

type Bucket = 'all' | 'draft' | 'pending_approval' | 'outstanding' | 'overdue' | 'paid';

type Invoice = {
  id: string;
  number: string;
  status: 'draft' | 'pending_approval' | 'open' | 'partially_paid' | 'paid' | 'void';
  currency: string;
  issue_date: string;
  due_date: string;
  total: string;
  amount_paid: string;
  balance: string;
  is_overdue: number;
  days_late: number | null;
  client_name: string;
  project_name: string | null;
  reminders_enabled: number;
  reminder_interval_days: number;
  reminder_count: number;
};

type Client = { id: string; name: string; billing_email: string | null };

type Summary = {
  draft_count: string;
  outstanding_amount: string;
  overdue_amount: string;
  overdue_count: string;
  paid_amount: string;
};

// Grouped digits without a currency code, for columns whose totals state it once.
const grouped = (value: string | number | undefined) =>
  Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const money = (value: string | number, currency = 'LKR') =>
  `${currency} ${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const STATUS_LABEL: Record<Invoice['status'], string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  open: 'Open',
  partially_paid: 'Part paid',
  paid: 'Paid',
  void: 'Void',
};

/** Overdue outranks the stored status: it is the thing that needs acting on. */
function statusTag(invoice: Invoice) {
  if (invoice.is_overdue) {
    return (
      <span className="status-tag status-suspended">
        Overdue{invoice.days_late ? ` · ${invoice.days_late}d` : ''}
      </span>
    );
  }
  const tone =
    invoice.status === 'paid' ? 'status-active'
    : invoice.status === 'void' ? 'status-suspended'
    : 'status-invited';
  return <span className={`status-tag ${tone}`}>{STATUS_LABEL[invoice.status]}</span>;
}

export function Invoices() {
  const { can } = useSession();
  const [bucket, setBucket] = useState<Bucket>('outstanding');
  const [openId, setOpenId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const summary = useQuery<Summary>('/invoices/summary', (signal) =>
    api.get('/invoices/summary', signal),
  );
  const list = useQuery<{ items: Invoice[] }>(`/invoices?bucket=${bucket}`, (signal) =>
    api.get(`/invoices?bucket=${bucket}`, signal),
  );

  const buckets: [Bucket, string][] = [
    ['outstanding', 'Outstanding'],
    ['overdue', 'Overdue'],
    ['draft', 'Drafts'],
    ['pending_approval', 'Awaiting approval'],
    ['paid', 'Paid'],
    ['all', 'All'],
  ];

  return (
    <section>
      <div className="dashboard-grid">
        <div className="panel metric-card">
          <span className="panel-title">Outstanding</span>
          <strong>{money(summary.data?.outstanding_amount ?? 0)}</strong>
        </div>
        <div className="panel metric-card">
          <span className="panel-title">Overdue</span>
          <strong className={Number(summary.data?.overdue_amount ?? 0) > 0 ? 'value-warn' : ''}>
            {money(summary.data?.overdue_amount ?? 0)}
          </strong>
          <span className="field-hint">{summary.data?.overdue_count ?? 0} invoice(s)</span>
        </div>
        <div className="panel metric-card">
          <span className="panel-title">Paid to date</span>
          <strong>{money(summary.data?.paid_amount ?? 0)}</strong>
        </div>
      </div>

      <div className="chip-row" style={{ marginTop: 'var(--sp-5)' }}>
        {buckets.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`chip ${bucket === value ? 'chip-active' : ''}`}
            onClick={() => setBucket(value)}
          >
            {label}
          </button>
        ))}
        {can('invoice.manage') ? (
          <button type="button" className="primary-button" style={{ marginLeft: 'auto' }}
                  onClick={() => setComposing(true)}>
            New invoice
          </button>
        ) : null}
      </div>

      {list.loading ? <Loading /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {list.data && list.data.items.length === 0 ? (
        <div className="state-block"><p>Nothing in this view.</p></div>
      ) : null}

      {list.data && list.data.items.length > 0 ? (
        <div className="panel" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th><th>Client</th><th>Project</th><th>Due</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                  <th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((invoice) => (
                  <tr key={invoice.id}>
                    <td><strong>{invoice.number}</strong></td>
                    <td>{invoice.client_name}</td>
                    <td>{invoice.project_name ?? '—'}</td>
                    <td>{String(invoice.due_date).slice(0, 10)}</td>
                    <td style={{ textAlign: 'right' }}>{money(invoice.total, invoice.currency)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {Number(invoice.balance) > 0 ? money(invoice.balance, invoice.currency) : '—'}
                    </td>
                    <td>{statusTag(invoice)}</td>
                    <td className="table-actions">
                      <button type="button" className="ghost-button"
                              onClick={() => setOpenId(invoice.id)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {composing ? (
        <ComposeInvoice
          onClose={() => setComposing(false)}
          onCreated={() => { setComposing(false); invalidate('/invoices'); }}
        />
      ) : null}

      {openId ? (
        <InvoiceDetail invoiceId={openId} onClose={() => setOpenId(null)} />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ compose */

type DraftLine = { description: string; quantity: string; unitPrice: string; taxRate: string };

function ComposeInvoice({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const inThirty = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const [clientOrgId, setClientOrgId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(inThirty);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [intervalDays, setIntervalDays] = useState('7');
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [lines, setLines] = useState<DraftLine[]>([
    { description: '', quantity: '1', unitPrice: '', taxRate: '0' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const clients = useQuery<{ items: Client[] }>(
    '/external/organizations?kind=client',
    (signal) => api.get('/external/organizations?kind=client', signal),
  );
  const projects = useQuery<Paged<{ id: string; name: string }>>('/projects', (signal) =>
    api.get('/projects', signal),
  );
  const selectedClient = clients.data?.items.find((client) => client.id === clientOrgId);
  const clientNeedsBillingEmail = Boolean(clientOrgId && !selectedClient?.billing_email);

  /**
   * A running total, shown while typing.
   *
   * This is a preview, not the invoice. The server recomputes from the lines on submit
   * and its answer is what the client is billed - so a rounding difference here can
   * never become a rounding difference on the document.
   */
  const preview = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const line of lines) {
      const amount = Number(line.quantity || 0) * Number(line.unitPrice || 0);
      if (!Number.isFinite(amount)) continue;
      const rounded = Number(amount.toFixed(2));
      subtotal += rounded;
      tax += Number(((rounded * Number(line.taxRate || 0)) / 100).toFixed(2));
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [lines]);

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(
        '/invoices',
        {
          clientOrgId,
          projectId: projectId || null,
          issueDate,
          dueDate,
          notes: notes || null,
          terms: terms || null,
          remindersEnabled,
          reminderIntervalDays: Number(intervalDays),
          lines: lines
            .filter((l) => l.description.trim())
            .map((l) => ({
              description: l.description.trim(),
              quantity: Number(l.quantity || 1),
              unitPrice: Number(l.unitPrice || 0),
              taxRate: Number(l.taxRate || 0),
            })),
        },
        { idempotencyKey: idempotencyKey() },
      );
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That invoice could not be created');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form
        className="dialog dialog-wide"
        role="dialog"
        aria-label="New invoice"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>New invoice</h3>

        <div className="field-row">
          <label className="field">
            <span>Client</span>
            <select value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)} required>
              <option value="">Choose a client…</option>
              {(clients.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.billing_email ? '' : ' - Missing billing email'}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Project <span className="field-hint">optional</span></span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {(projects.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>

        {clientNeedsBillingEmail ? (
          <div className="degraded-notice" role="status">
            <div>
              <strong>Billing email required before submission</strong>
              <p>This draft can be saved, but it cannot be sent for approval until the client has a billing email.</p>
            </div>
          </div>
        ) : null}

        <div className="field-row">
          <label className="field">
            <span>Issue date</span>
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Due date</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
          </label>
        </div>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Description</th>
                <th style={{ width: 90 }}>Qty</th>
                <th style={{ width: 130 }}>Unit price</th>
                <th style={{ width: 90 }}>Tax %</th>
                <th style={{ width: 120, textAlign: 'right' }}>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td>
                    <input value={line.description} placeholder="What is being billed"
                           onChange={(e) => setLine(index, { description: e.target.value })} />
                  </td>
                  <td>
                    <input type="number" min="0" step="0.001" value={line.quantity}
                           onChange={(e) => setLine(index, { quantity: e.target.value })} />
                  </td>
                  <td>
                    <input type="number" min="0" step="0.01" value={line.unitPrice}
                           onChange={(e) => setLine(index, { unitPrice: e.target.value })} />
                  </td>
                  <td>
                    <input type="number" min="0" max="100" step="0.01" value={line.taxRate}
                           onChange={(e) => setLine(index, { taxRate: e.target.value })} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {grouped(Number(line.quantity || 0) * Number(line.unitPrice || 0))}
                  </td>
                  <td>
                    {lines.length > 1 ? (
                      <button type="button" className="ghost-button"
                              aria-label={`Remove line ${index + 1}`}
                              onClick={() => setLines((c) => c.filter((_, i) => i !== index))}>
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button type="button" className="ghost-button"
                onClick={() => setLines((c) => [...c, { description: '', quantity: '1', unitPrice: '', taxRate: '0' }])}>
          Add line
        </button>

        <dl className="claim-total">
          <dt>Subtotal</dt><dd>{grouped(preview.subtotal)}</dd>
          <dt>Tax</dt><dd>{grouped(preview.tax)}</dd>
          <dt><strong>Total</strong></dt><dd><strong>{grouped(preview.total)}</strong></dd>
        </dl>

        <label className="field">
          <span>Notes <span className="field-hint">shown on the invoice</span></span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label className="field">
          <span>Payment terms</span>
          <textarea rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>

        <div className="checkbox-row">
          <label>
            <input type="checkbox" checked={remindersEnabled}
                   onChange={(e) => setRemindersEnabled(e.target.checked)} />
            Chase this invoice automatically once it is overdue
          </label>
          <label className="field">
            <span>Every</span>
            <select value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)}
                    disabled={!remindersEnabled}>
              {['1', '2', '3', '5', '7', '14', '30'].map((d) => (
                <option key={d} value={d}>{d} day{d === '1' ? '' : 's'}</option>
              ))}
            </select>
          </label>
        </div>

        {error ? <p className="field-error">{error}</p> : null}

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || !clientOrgId}>
            {saving ? 'Creating…' : 'Create draft'}
          </button>
        </div>
        <p className="field-hint">
          It is created as a draft. Nothing reaches the client until you issue it.
        </p>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------- detail */

function InvoiceDetail({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { can, session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [chasing, setChasing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [receiptFor, setReceiptFor] = useState<any | null>(null);
  const [signingInvoice, setSigningInvoice] = useState(false);
  const [clientCopyFor, setClientCopyFor] = useState<'invoice' | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [addingBillingEmail, setAddingBillingEmail] = useState(false);
  const { ask, element: promptDialog } = useTextPrompt();

  const detail = useQuery<any>(`/invoices/${invoiceId}`, (signal) =>
    api.get(`/invoices/${invoiceId}`, signal),
  );
  const invoice = detail.data;

  const signatureQuery = useQuery<SignatureState>(`/signatures/invoice/${invoiceId}`, (signal) =>
    api.get(`/signatures/invoice/${invoiceId}`, signal),
  );
  const signatures = useSignatureImages(signatureQuery.data);
  const myRole = nextInternalRole(signatures, session?.user?.id);
  const clientNeedsBillingEmail = Boolean(invoice && !invoice.billing_email);

  async function act(run: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await run();
      invalidate('/invoices');
      detail.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-label="Invoice"
           onClick={(e) => e.stopPropagation()}>
        {detail.loading ? <Loading /> : null}
        {detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : null}

        {invoice ? (
          <>
            <header className="module-header">
              <div>
                <h3>{invoice.number}</h3>
                <p className="field-hint">
                  {invoice.client_name}
                  {invoice.project_name ? ` · ${invoice.project_name}` : ''}
                </p>
              </div>
              <div className="header-controls">
                {/* Preview and signing were built but never given a way in, which made
                    the invoice look like a bare list of fields next to a quotation that
                    shows the real document. They sit first because looking at what the
                    client will receive comes before deciding anything about it. */}
                <button type="button" className="ghost-button" onClick={() => setPreviewing(true)}>
                  Preview &amp; PDF
                </button>

                {can('document.sign') && myRole && invoice.status !== 'void' ? (
                  <button type="button" className="ghost-button"
                          onClick={() => setSigningInvoice(true)}>
                    Sign as {myRole === 'internal_1' ? 'first' : 'second'} signatory
                  </button>
                ) : null}

                {/* Asking a colleague for the second internal signature. The dialog was
                    mounted below but nothing ever opened it, so the request could not be
                    made from an invoice at all. Offered only once you have signed
                    yourself: asking before you sign inverts the point of a
                    countersignature. */}
                {can('document.sign')
                  && (signatures?.signatures?.length ?? 0) === 1
                  && !signatures?.signatures?.some((sig) => sig.role === 'internal_2')
                  && invoice.status !== 'void' ? (
                  <button type="button" className="ghost-button"
                          onClick={() => setRequesting(true)}>
                    Request countersignature
                  </button>
                ) : null}

                {invoice.status === 'draft' && can('invoice.manage') && !clientNeedsBillingEmail ? (
                  <button type="button" className="primary-button" disabled={busy}
                          onClick={() => act(() => api.post(`/invoices/${invoiceId}/submit`, {},
                            { idempotencyKey: idempotencyKey() }))}>
                    Submit for approval
                  </button>
                ) : null}

                {/* Releasing to the client is a super-administrator act, separate from
                    drafting it. Anyone else sees the state, not the buttons. */}
                {invoice.status === 'pending_approval' && can('invoice.approve') ? (
                  <>
                    <button type="button" className="ghost-button" disabled={busy}
                            onClick={async () => {
                              const reason = await ask({
                                title: 'Send this invoice back',
                                label: 'Reason',
                                description:
                                  'The author sees this, so say what needs changing.',
                                minLength: 4,
                                confirmLabel: 'Send back',
                              });
                              if (reason) void act(() => api.post(`/invoices/${invoiceId}/reject`, { reason }));
                            }}>
                      Send back
                    </button>
                    <button type="button" className="primary-button" disabled={busy}
                            onClick={() => act(() => api.post(`/invoices/${invoiceId}/approve`, {},
                              { idempotencyKey: idempotencyKey() }))}>
                      Approve and email client
                    </button>
                  </>
                ) : null}

                {invoice.status === 'pending_approval' && !can('invoice.approve') ? (
                  <span className="status-tag status-invited">
                    Waiting on a super administrator
                  </span>
                ) : null}
                {invoice.status !== 'draft' && invoice.status !== 'pending_approval'
                  && invoice.status !== 'paid'
                  && invoice.status !== 'void' && can('payment.record') ? (
                  <button type="button" className="primary-button" onClick={() => setPaying(true)}>
                    Record payment
                  </button>
                ) : null}
              </div>
            </header>

            {clientNeedsBillingEmail ? (
              <div className="degraded-notice" role="alert">
                <div>
                  <strong>Billing email needed</strong>
                  <p>
                    {invoice.client_name} cannot receive this invoice until a billing email is added.
                  </p>
                </div>
                {can('external_org.manage') ? (
                  <button type="button" className="primary-button" onClick={() => setAddingBillingEmail(true)}>
                    Add billing email
                  </button>
                ) : null}
              </div>
            ) : null}

            {signatures && !signatures.intact ? (
              <p className="field-error">
                This invoice changed after it was signed, so the signatures no longer
                cover it.
              </p>
            ) : null}

            {signatures && signatures.signatures.length > 0 ? (
              <p className="field-hint">
                Signed by {signatures.signatures.map((sig) => sig.signer_name).join(', ')}
                {' '}({signatures.signatures.length} of {signatures.required.length})
              </p>
            ) : null}

            <dl className="detail-list">
              {invoice.representative || invoice.billing_email ? (
                <>
                  <dt>Billed to</dt>
                  <dd>
                    {invoice.representative ? `${invoice.representative}, ` : ''}
                    {invoice.client_name}
                    {invoice.billing_email ? ` · ${invoice.billing_email}` : ''}
                  </dd>
                </>
              ) : null}
              <dt>Issued</dt><dd>{String(invoice.issue_date).slice(0, 10)}</dd>
              <dt>Due</dt><dd>{String(invoice.due_date).slice(0, 10)}</dd>
              <dt>Total</dt><dd>{money(invoice.total, invoice.currency)}</dd>
              <dt>Paid</dt><dd>{money(invoice.amount_paid, invoice.currency)}</dd>
              <dt>Balance</dt><dd><strong>{money(invoice.balance, invoice.currency)}</strong></dd>
              <dt>Reminders</dt>
              <dd>
                {invoice.reminders_enabled
                  ? `Every ${invoice.reminder_interval_days} day(s)` : 'Off'}
                {invoice.reminder_count > 0 ? ` · ${invoice.reminder_count} sent` : ''}
              </dd>
            </dl>

            <h4>Lines</h4>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Description</th><th>Qty</th><th>Unit</th><th>Tax</th>
                      <th style={{ textAlign: 'right' }}>Amount</th></tr>
                </thead>
                <tbody>
                  {(invoice.lines ?? []).map((l: any) => (
                    <tr key={l.id}>
                      <td>{l.description}</td>
                      <td>{Number(l.quantity)}</td>
                      <td>{grouped(l.unit_price)}</td>
                      <td>{Number(l.tax_rate)}%</td>
                      <td style={{ textAlign: 'right' }}>{grouped(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4>Payments</h4>
            {(invoice.payments ?? []).length === 0 ? (
              <p className="field-hint">Nothing received yet.</p>
            ) : (
              <ul className="plain-list">
                {invoice.payments.map((p: any) => (
                  <li key={p.id}>
                    <strong>{money(p.amount, invoice.currency)}</strong>
                    {' · '}{String(p.paid_on).slice(0, 10)}
                    {' · '}{p.method?.replace('_', ' ')}
                    {p.receipt_number ? ` · receipt ${p.receipt_number}` : ''}
                    {p.recorded_by_name ? ` · recorded by ${p.recorded_by_name}` : ''}
                    {' '}
                    <button type="button" className="ghost-button" onClick={() => setReceiptFor(p)}>
                      View receipt
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error ? <p className="field-error">{error}</p> : null}

            <div className="dialog-actions">
              {/* Voiding is refused by the server once money has landed; the button is
                  hidden in that case rather than offering an action that will fail. */}
              {can('invoice.manage') && Number(invoice.amount_paid) === 0
                && invoice.status !== 'void' && invoice.status !== 'paid' ? (
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy}
                  onClick={async () => {
                    const reason = await ask({
                      title: 'Void this invoice',
                      label: 'Reason',
                      description:
                        'Voiding cannot be undone. The invoice stays on record with this reason.',
                      minLength: 4,
                      confirmLabel: 'Void invoice',
                      destructive: true,
                    });
                    if (reason) void act(() => api.post(`/invoices/${invoiceId}/void`, { reason }));
                  }}
                >
                  Void invoice
                </button>
              ) : null}
              {can('invoice.manage') && invoice.status !== 'paid' && invoice.status !== 'void' ? (
                <button type="button" className="ghost-button" onClick={() => setChasing(true)}>
                  Reminder settings
                </button>
              ) : null}
              <button type="button" className="ghost-button" onClick={onClose}>Close</button>
            </div>

            {previewing ? (
              <DocumentPreview
                invoice={invoice}
                signatures={signatures}
                onClose={() => setPreviewing(false)}
              />
            ) : null}

            {signingInvoice && myRole ? (
              <SignInvoice
                invoice={invoice}
                role={myRole}
                onClose={() => setSigningInvoice(false)}
                onSigned={() => { setSigningInvoice(false); signatureQuery.reload(); }}
              />
            ) : null}

            {requesting ? (
              <RequestCountersignatureDialog
                documentType="invoice"
                documentId={invoiceId}
                documentLabel={invoice.number}
                onClose={() => setRequesting(false)}
                onRequested={() => { setRequesting(false); signatureQuery.reload(); }}
              />
            ) : null}

            {clientCopyFor ? (
              <RecordClientSignatureDialog
                documentType="invoice"
                documentId={invoiceId}
                role="client_1"
                onClose={() => setClientCopyFor(null)}
                onRecorded={() => { setClientCopyFor(null); signatureQuery.reload(); }}
              />
            ) : null}

            {receiptFor ? (
              <ReceiptPanel
                invoice={invoice}
                payment={receiptFor}
                onClose={() => setReceiptFor(null)}
              />
            ) : null}

            {promptDialog}

            {chasing ? (
              <ReminderPolicy
                invoiceId={invoiceId}
                enabled={Boolean(invoice.reminders_enabled)}
                intervalDays={Number(invoice.reminder_interval_days)}
                onClose={() => setChasing(false)}
                onSaved={() => { setChasing(false); detail.reload(); invalidate('/invoices'); }}
              />
            ) : null}

            {paying ? (
              <RecordPayment
                invoiceId={invoiceId}
                balance={Number(invoice.balance)}
                currency={invoice.currency}
                onClose={() => setPaying(false)}
                onRecorded={() => { setPaying(false); invalidate('/invoices'); detail.reload(); }}
              />
            ) : null}

            {addingBillingEmail ? (
              <AddBillingEmail
                clientOrgId={invoice.client_org_id}
                clientName={invoice.client_name}
                onClose={() => setAddingBillingEmail(false)}
                onSaved={() => {
                  setAddingBillingEmail(false);
                  invalidate('/external/organizations');
                  detail.reload();
                }}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function AddBillingEmail({
  clientOrgId, clientName, onClose, onSaved,
}: {
  clientOrgId: string; clientName: string; onClose: () => void; onSaved: () => void;
}) {
  const [billingEmail, setBillingEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/external/organizations/${clientOrgId}`, { billingEmail });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The billing email could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={`Add billing email for ${clientName}`}
            onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h3>Add billing email</h3>
        <p className="field-hint">This is where approval and invoice delivery notices will be sent.</p>
        <label className="field" htmlFor="invoice-client-billing-email">
          <span>Billing email</span>
          <input id="invoice-client-billing-email" type="email" autoFocus required value={billingEmail}
                 onChange={(event) => setBillingEmail(event.target.value)} />
        </label>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : 'Save billing email'}
          </button>
        </div>
      </form>
    </div>
  );
}

function RecordPayment({
  invoiceId, balance, currency, onClose, onRecorded,
}: {
  invoiceId: string; balance: number; currency: string;
  onClose: () => void; onRecorded: () => void;
}) {
  // Defaulting to the full balance is the common case; part payments are the exception.
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(
        `/invoices/${invoiceId}/payments`,
        { amount: Number(amount), paidOn, method, reference: reference || null },
        { idempotencyKey: idempotencyKey() },
      );
      onRecorded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That payment could not be recorded');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="Record payment"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Record payment</h3>
        <p className="field-hint">Outstanding: {currency} {grouped(balance)}</p>
        <label className="field">
          <span>Amount received</span>
          <input type="number" min="0.01" step="0.01" max={balance} value={amount}
                 onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label className="field">
          <span>Date received</span>
          <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required />
        </label>
        <label className="field">
          <span>Method</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="bank_transfer">Bank transfer</option>
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="cheque">Cheque</option>
            <option value="online">Online</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">
          <span>Reference <span className="field-hint">optional</span></span>
          <input value={reference} onChange={(e) => setReference(e.target.value)}
                 placeholder="Bank reference or slip number" />
        </label>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Recording…' : 'Record and send receipt'}
          </button>
        </div>
      </form>
    </div>
  );
}


/**
 * How often an overdue invoice chases the client.
 *
 * Per invoice rather than a single company-wide setting: a client who always pays late
 * and one who is disputing a line need different treatment, and a global cadence forces
 * the same tone on both.
 */
function ReminderPolicy({
  invoiceId, enabled, intervalDays, onClose, onSaved,
}: {
  invoiceId: string; enabled: boolean; intervalDays: number;
  onClose: () => void; onSaved: () => void;
}) {
  const [on, setOn] = useState(enabled);
  const [days, setDays] = useState(String(intervalDays || 7));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.put(`/invoices/${invoiceId}/reminders`, {
        enabled: on,
        intervalDays: Number(days),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="Reminder settings"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Payment reminders</h3>
        <div className="checkbox-row">
          <label>
            <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
            Chase this invoice once it is overdue
          </label>
        </div>
        <label className="field">
          <span>Send a reminder every</span>
          <select value={days} onChange={(e) => setDays(e.target.value)} disabled={!on}>
            {['1', '2', '3', '5', '7', '14', '30'].map((d) => (
              <option key={d} value={d}>{d} day{d === '1' ? '' : 's'}</option>
            ))}
          </select>
        </label>
        <p className="field-hint">
          Reminders start only after the due date, and stop the moment the invoice is
          settled.
        </p>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}


/**
 * The document as the client will receive it.
 *
 * Printing goes through the browser rather than a server-side PDF: the same markup is
 * already on screen, print styles reduce it to the sheet alone, and "Save as PDF" in the
 * print dialog produces the file. A second rendering path would be a second thing that
 * can disagree with what was approved.
 */
function DocumentPreview({
  invoice,
  variant = 'invoice',
  payment,
  signatures,
  onClose,
}: {
  invoice: InvoiceForDocument;
  variant?: 'invoice' | 'receipt';
  payment?: any;
  signatures?: SignatureState;
  onClose: () => void;
}) {
  const profile = useQuery<BillingProfile>('/billing/settings', (signal) =>
    api.get('/billing/settings', signal),
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-label={variant === 'receipt' ? 'Receipt preview' : 'Invoice preview'}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="panel-header no-print">
          <span className="panel-title">
            {variant === 'receipt' ? 'Receipt preview' : 'Invoice preview'}
          </span>
          <div className="table-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => void openDocumentPdf('receipt', payment.id)}
            >
              Download PDF
            </button>
            <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          </div>
        </header>

        {profile.data ? (
          <InvoiceDocument
            invoice={invoice}
            profile={profile.data}
            variant={variant}
            payment={payment}
            signatures={signatures?.signatures}
            requiredRoles={signatures?.required}
          />
        ) : (
          <p className="field-hint">Loading your billing details…</p>
        )}

        <p className="field-hint no-print">
          Letterhead, payment instructions and footers come from Settings → Invoice and
          receipt details.
        </p>
      </div>
    </div>
  );
}


/** Placing a signature on the invoice itself, so what is signed is what is sent. */
function SignInvoice({
  invoice, role, onClose, onSigned,
}: {
  invoice: any; role: 'internal_1' | 'internal_2';
  onClose: () => void; onSigned: () => void;
}) {
  const profile = useQuery<BillingProfile>('/billing/settings', (signal) =>
    api.get('/billing/settings', signal),
  );
  // Signatures already on the document, so the slots that are taken read as taken while
  // you choose where to put yours.
  const state = useQuery<SignatureState>(`/signatures/invoice/${invoice.id}`, (signal) =>
    api.get(`/signatures/invoice/${invoice.id}`, signal),
  );
  if (!profile.data) return null;
  return (
    <SignDocumentDialog
      documentType="invoice"
      documentId={invoice.id}
      documentLabel={invoice.number}
      role={role}
      onClose={onClose}
      onSigned={onSigned}
    >
      <InvoiceDocument
        invoice={invoice}
        profile={profile.data}
        signatures={state.data?.signatures}
        requiredRoles={state.data?.required}
      />
    </SignDocumentDialog>
  );
}

/**
 * A receipt, with its own signatures.
 *
 * Four rather than three: both sides acknowledge that money changed hands, so the client
 * has two slots where an invoice gives them one.
 */
function ReceiptPanel({
  invoice, payment, onClose,
}: { invoice: any; payment: any; onClose: () => void }) {
  const { can, session } = useSession();
  const [signing, setSigning] = useState(false);
  const [clientSlot, setClientSlot] = useState<'client_1' | 'client_2' | null>(null);

  const profile = useQuery<BillingProfile>('/billing/settings', (signal) =>
    api.get('/billing/settings', signal),
  );
  const state = useQuery<SignatureState>(`/signatures/receipt/${payment.id}`, (signal) =>
    api.get(`/signatures/receipt/${payment.id}`, signal),
  );
  const signatures = useSignatureImages(state.data);
  const myRole = nextInternalRole(signatures, session?.user?.id);
  const taken = new Set((signatures?.signatures ?? []).map((s) => s.role));

  if (!profile.data) return null;

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-label="Receipt"
           onClick={(event) => event.stopPropagation()}>
        <header className="panel-header no-print">
          <span className="panel-title">
            Receipt {payment.receipt_number}
            {signatures ? ` · ${signatures.signatures.length} of ${signatures.required.length} signed` : ''}
          </span>
          <div className="table-actions">
            {can('document.sign') && myRole ? (
              <button type="button" className="primary-button" onClick={() => setSigning(true)}>
                Sign
              </button>
            ) : null}
            {can('document.sign') && !taken.has('client_1') ? (
              <button type="button" className="ghost-button" onClick={() => setClientSlot('client_1')}>
                Client signature
              </button>
            ) : null}
            {can('document.sign') && taken.has('client_1') && !taken.has('client_2') ? (
              <button type="button" className="ghost-button" onClick={() => setClientSlot('client_2')}>
                Second client signature
              </button>
            ) : null}
            <button
              type="button"
              className="ghost-button"
              onClick={() => void openDocumentPdf('receipt', payment.id)}
            >
              Download PDF
            </button>
            <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          </div>
        </header>

        {signatures && !signatures.intact ? (
          <p className="field-error no-print">
            This receipt changed after it was signed.
          </p>
        ) : null}

        <InvoiceDocument
          invoice={invoice}
          profile={profile.data}
          variant="receipt"
          payment={payment}
          signatures={signatures?.signatures}
          requiredRoles={signatures?.required}
        />

        {signing && myRole ? (
          <SignDocumentDialog
            documentType="receipt"
            documentId={payment.id}
            documentLabel={payment.receipt_number}
            role={myRole}
            onClose={() => setSigning(false)}
            onSigned={() => { setSigning(false); state.reload(); }}
          >
            <InvoiceDocument
              invoice={invoice}
              profile={profile.data!}
              variant="receipt"
              payment={payment}
              signatures={state.data?.signatures}
              requiredRoles={state.data?.required}
            />
          </SignDocumentDialog>
        ) : null}

        {clientSlot ? (
          <RecordClientSignatureDialog
            documentType="receipt"
            documentId={payment.id}
            role={clientSlot}
            onClose={() => setClientSlot(null)}
            onRecorded={() => { setClientSlot(null); state.reload(); }}
          />
        ) : null}
      </div>
    </div>
  );
}
