/**
 * Quotations: the pipeline from a prospect to a signed piece of work.
 *
 * The list is organised by what needs doing rather than by date — awaiting a
 * countersignature, ready to send, out with the prospect — because that is the question
 * somebody opens this screen to answer.
 */
import { useMemo, useState } from 'react';
import { openDocumentPdf } from '../lib/documents-pdf';
import { api, ApiError, idempotencyKey } from '../lib/api';
import { invalidate, useQuery } from '../lib/query';
import { useSession } from '../lib/session';
import { useNotify } from '../lib/notify';
import { useTextPrompt } from './Prompt';
import { QuotationDocument } from './QuotationDocument';
import type { BillingProfile } from './InvoiceDocument';
import {
  RecordClientSignatureDialog, RequestCountersignatureDialog, SignDocumentDialog,
} from './DocumentSigning';

type Quotation = {
  id: string;
  number: string;
  status: string;
  currency: string;
  issue_date: string;
  valid_until: string | null;
  total: string;
  revision: number;
  superseded_by: string | null;
  decline_reason: string | null;
  org_name: string;
  org_status: string;
  signature_count: string;
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  awaiting_countersign: 'Awaiting countersignature',
  ready_to_send: 'Ready to send',
  sent: 'With the prospect',
  under_revision: 'Being revised',
  accepted: 'Accepted',
  declined: 'Not converted',
  superseded: 'Superseded',
};

const STATUS_TONE: Record<string, string> = {
  accepted: 'status-active',
  declined: 'status-suspended',
  superseded: 'status-suspended',
  sent: 'status-invited',
};

const money = (value: string | number, currency: string) =>
  `${currency} ${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

export function Quotations() {
  const { can } = useSession();
  const [filter, setFilter] = useState<string>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const list = useQuery<{ items: Quotation[] }>('/quotations', (signal) =>
    api.get('/quotations', signal),
  );

  const shown = useMemo(() => {
    const items = list.data?.items ?? [];
    if (filter === 'all') return items;
    if (filter === 'open') {
      return items.filter((q) => !['accepted', 'declined', 'superseded'].includes(q.status));
    }
    return items.filter((q) => q.status === filter);
  }, [list.data, filter]);

  const filters: [string, string][] = [
    ['open', 'In progress'],
    ['sent', 'With prospects'],
    ['accepted', 'Converted'],
    ['declined', 'Not converted'],
    ['all', 'All'],
  ];

  return (
    <section>
      <div className="chip-row">
        {filters.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`chip ${filter === value ? 'chip-active' : ''}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
        {can('quotation.manage') ? (
          <button type="button" className="primary-button" style={{ marginLeft: 'auto' }}
                  onClick={() => setComposing(true)}>
            New quotation
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <div className="state-block">
          <p>Nothing here. A quotation is how a prospect becomes a client.</p>
        </div>
      ) : (
        <div className="panel">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Number</th><th>Organisation</th><th>Issued</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th>Signatures</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map((quotation) => (
                  <tr key={quotation.id}>
                    <td>
                      <strong>{quotation.number}</strong>
                      {quotation.revision > 1 ? (
                        <span className="task-meta"> · revision {quotation.revision}</span>
                      ) : null}
                    </td>
                    <td>
                      {quotation.org_name}
                      {quotation.org_status === 'upcoming' ? (
                        <span className="task-meta"> · prospect</span>
                      ) : null}
                    </td>
                    <td>{String(quotation.issue_date).slice(0, 10)}</td>
                    <td style={{ textAlign: 'right' }}>{money(quotation.total, quotation.currency)}</td>
                    <td>{quotation.signature_count} of 3</td>
                    <td>
                      <span className={`status-tag ${STATUS_TONE[quotation.status] ?? 'status-invited'}`}>
                        {STATUS_LABEL[quotation.status] ?? quotation.status}
                      </span>
                    </td>
                    <td className="table-actions">
                      <button type="button" className="ghost-button"
                              onClick={() => setOpenId(quotation.id)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {composing ? (
        <ComposeQuotation
          onClose={() => setComposing(false)}
          onCreated={() => { setComposing(false); invalidate('/quotations'); list.reload(); }}
        />
      ) : null}

      {openId ? (
        <QuotationDetail
          quotationId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => { invalidate('/quotations'); list.reload(); }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ compose */

type DraftLine = { description: string; quantity: string; unitPrice: string; taxRate: string };

function ComposeQuotation({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [orgId, setOrgId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [validUntil, setValidUntil] = useState(
    new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  );
  const [summary, setSummary] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { description: '', quantity: '1', unitPrice: '', taxRate: '0' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Prospects and clients both: a quotation for more work with an existing client is
  // the same document.
  const orgs = useQuery<{ items: { id: string; name: string; status: string }[] }>(
    '/external/organizations',
    (signal) => api.get('/external/organizations', signal),
  );

  const preview = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const line of lines) {
      const amount = Number(Number(line.quantity || 0) * Number(line.unitPrice || 0));
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
      await api.post('/quotations', {
        orgId,
        issueDate,
        validUntil: validUntil || null,
        summary: summary || null,
        terms: terms || null,
        lines: lines.filter((l) => l.description.trim()).map((l) => ({
          description: l.description.trim(),
          quantity: Number(l.quantity || 1),
          unitPrice: Number(l.unitPrice || 0),
          taxRate: Number(l.taxRate || 0),
        })),
      }, { idempotencyKey: idempotencyKey() });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That quotation could not be created');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog dialog-wide" role="dialog" aria-label="New quotation"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New quotation</h3>

        <div className="field-row">
          <label className="field">
            <span>Organisation</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
              <option value="">Choose…</option>
              {(orgs.data?.items ?? []).map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}{org.status === 'upcoming' ? ' (prospect)' : ''}
                </option>
              ))}
            </select>
            <span className="field-hint">
              A prospect becomes a client automatically when the quotation is accepted.
            </span>
          </label>
          <label className="field">
            <span>Issued</span>
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Valid until</span>
            <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Summary</span>
          <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)}
                    placeholder="What is being proposed, in a sentence or two." />
        </label>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Description</th>
                <th style={{ width: 90 }}>Qty</th>
                <th style={{ width: 130 }}>Unit price</th>
                <th style={{ width: 90 }}>Tax %</th>
                <th style={{ width: 110, textAlign: 'right' }}>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td><input value={line.description} placeholder="What is being quoted"
                             onChange={(e) => setLine(index, { description: e.target.value })} /></td>
                  <td><input type="number" min="0" step="0.001" value={line.quantity}
                             onChange={(e) => setLine(index, { quantity: e.target.value })} /></td>
                  <td><input type="number" min="0" step="0.01" value={line.unitPrice}
                             onChange={(e) => setLine(index, { unitPrice: e.target.value })} /></td>
                  <td><input type="number" min="0" max="100" step="0.01" value={line.taxRate}
                             onChange={(e) => setLine(index, { taxRate: e.target.value })} /></td>
                  <td style={{ textAlign: 'right' }}>
                    {(Number(line.quantity || 0) * Number(line.unitPrice || 0)).toFixed(2)}
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
          <dt>Subtotal</dt><dd>{preview.subtotal.toFixed(2)}</dd>
          <dt>Tax</dt><dd>{preview.tax.toFixed(2)}</dd>
          <dt><strong>Total</strong></dt><dd><strong>{preview.total.toFixed(2)}</strong></dd>
        </dl>

        <label className="field">
          <span>Terms</span>
          <textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || !orgId}>
            {saving ? 'Creating…' : 'Create draft'}
          </button>
        </div>
        <p className="field-hint">
          It is created as a draft. Two people here must sign it before it can be sent.
        </p>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------- detail */

function QuotationDetail({
  quotationId, onClose, onChanged,
}: { quotationId: string; onClose: () => void; onChanged: () => void }) {
  const { can, session } = useSession();
  const { notify } = useNotify();
  const { ask, element: promptDialog } = useTextPrompt();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [revising, setRevising] = useState(false);
  const [recordingClient, setRecordingClient] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const detail = useQuery<any>(`/quotations/${quotationId}`, (signal) =>
    api.get(`/quotations/${quotationId}`, signal),
  );
  const profile = useQuery<BillingProfile>('/billing/settings', (signal) =>
    api.get('/billing/settings', signal),
  );

  const quotation = detail.data;
  const state = quotation?.signatures;

  async function act(run: () => Promise<unknown>, message?: string) {
    setError(null);
    setBusy(true);
    try {
      await run();
      if (message) notify({ severity: 'success', title: message });
      detail.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const alreadySigned = state?.signatures?.some(
    (s: any) => s.signer_user_id === session?.user?.id,
  );
  const internalCount = state?.signatures?.filter((s: any) => s.role.startsWith('internal_')).length ?? 0;
  const nextRole = internalCount === 0 ? 'internal_1' : 'internal_2';

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-label="Quotation"
           onClick={(e) => e.stopPropagation()}>
        {quotation ? (
          <>
            <header className="task-detail-head">
              <div>
                <span className="task-detail-ref">{quotation.number}</span>
                <h3 className="task-detail-title">{quotation.org_name}</h3>
                <p className="field-hint">
                  {STATUS_LABEL[quotation.status] ?? quotation.status}
                  {' · '}{internalCount} of 2 internal signatures
                  {state && !state.intact ? ' · changed after signing' : ''}
                </p>
              </div>
              <div className="table-actions">
                {can('document.sign') && internalCount < 2 && !alreadySigned
                  && !['accepted', 'declined', 'superseded'].includes(quotation.status) ? (
                  <button type="button" className="primary-button" onClick={() => setSigning(true)}>
                    Sign as {internalCount === 0 ? 'first' : 'second'} signatory
                  </button>
                ) : null}

                {/* Only once you have signed and a slot is still open: asking before
                    signing yourself inverts the point of a countersignature. */}
                {can('document.sign')
                  && (state?.signatures?.length ?? 0) === 1
                  && !state?.signatures?.some((sig: any) => sig.role === 'internal_2') ? (
                  <button type="button" className="ghost-button"
                          onClick={() => setRequesting(true)}>
                    Request countersignature
                  </button>
                ) : null}
                <button type="button" className="ghost-button" onClick={onClose}>Close</button>
              </div>
            </header>

            {state && !state.intact ? (
              <p className="field-error">
                This quotation changed after it was signed, so the existing signatures no
                longer cover it. Create a revision and sign that instead.
              </p>
            ) : null}

            {profile.data ? (
              <QuotationDocument
                quotation={quotation}
                profile={profile.data}
                signatures={(state?.signatures ?? []).map((s: any) => ({
                  role: s.role, signer_name: s.signer_name,
                  signed_at: s.signed_at, valid: s.valid, imageUrl: s.imageUrl,
                }))}
                requiredRoles={state?.required ?? ['internal_1', 'internal_2', 'client_1']}
              />
            ) : null}

            {error ? <p className="field-error">{error}</p> : null}

            <div className="dialog-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => void openDocumentPdf('quotation', quotationId)}
              >
                Download PDF
              </button>

              {can('quotation.manage') && internalCount >= 2 && quotation.status !== 'sent'
                && !['accepted', 'declined', 'superseded'].includes(quotation.status) ? (
                <button type="button" className="primary-button" disabled={busy}
                        onClick={() => act(async () => {
                          await api.post(`/quotations/${quotationId}/ready`, {});
                          await api.post(`/quotations/${quotationId}/send`, {});
                        }, 'Sent to the prospect')}>
                  Send to prospect
                </button>
              ) : null}

              {/* The prospect asked for changes. A revision, never an edit: the
                  current version may already be signed. */}
              {can('quotation.manage')
                && !['accepted', 'superseded'].includes(quotation.status) ? (
                <button type="button" className="ghost-button" onClick={() => setRevising(true)}>
                  Revise after discussion
                </button>
              ) : null}

              {/* Their signature happens on paper; this records the copy they returned. */}
              {can('document.sign') && internalCount >= 2
                && !state?.signatures?.some((s: any) => s.role === 'client_1') ? (
                <button type="button" className="ghost-button" onClick={() => setRecordingClient(true)}>
                  Upload signed copy
                </button>
              ) : null}

              {can('quotation.manage') && quotation.status === 'sent' ? (
                <>
                  <button type="button" className="ghost-button" disabled={busy}
                          onClick={async () => {
                            const reason = await ask({
                              title: 'Not converted',
                              label: 'Why did it not go ahead?',
                              description: 'Recorded against the quotation. This is the most '
                                + 'useful thing to know when the next one is written.',
                              minLength: 4,
                              confirmLabel: 'Mark not converted',
                              destructive: true,
                            });
                            if (reason) {
                              void act(() => api.post(`/quotations/${quotationId}/decline`, { reason }),
                                'Recorded as not converted');
                            }
                          }}>
                    Not converted
                  </button>
                  <button type="button" className="primary-button" disabled={busy}
                          onClick={() => act(() => api.post(`/quotations/${quotationId}/accept`, {}),
                            'Accepted — the prospect is now a client')}>
                    Accepted — convert to client
                  </button>
                </>
              ) : null}
            </div>

            {quotation.decline_reason ? (
              <p className="field-hint">Not converted: {quotation.decline_reason}</p>
            ) : null}

            {(quotation.history ?? []).length > 1 ? (
              <section>
                <h4>Revisions</h4>
                <ul className="plain-list">
                  {quotation.history.map((entry: any) => (
                    <li key={entry.id}>
                      {entry.number} · revision {entry.revision} ·{' '}
                      {STATUS_LABEL[entry.status] ?? entry.status}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {signing && profile.data ? (
              <SignDocumentDialog
                documentType="quotation"
                documentId={quotationId}
                documentLabel={quotation.number}
                role={nextRole as 'internal_1' | 'internal_2'}
                onClose={() => setSigning(false)}
                onSigned={() => { setSigning(false); detail.reload(); onChanged(); }}
              >
                <QuotationDocument
                  quotation={quotation}
                  profile={profile.data}
                  signatures={(state?.signatures ?? []).map((sig: any) => ({
                    role: sig.role, signer_name: sig.signer_name,
                    signed_at: sig.signed_at, valid: sig.valid, imageUrl: sig.imageUrl,
                  }))}
                  requiredRoles={state?.required}
                />
              </SignDocumentDialog>
            ) : null}

            {revising ? (
              <ReviseQuotation
                quotation={quotation}
                onClose={() => setRevising(false)}
                onRevised={() => { setRevising(false); detail.reload(); onChanged(); }}
              />
            ) : null}

            {recordingClient ? (
              <RecordClientSignatureDialog
                documentType="quotation"
                documentId={quotationId}
                role="client_1"
                onClose={() => setRecordingClient(false)}
                onRecorded={() => { setRecordingClient(false); detail.reload(); onChanged(); }}
              />
            ) : null}

            {requesting ? (
              <RequestCountersignatureDialog
                documentType="quotation"
                documentId={quotationId}
                documentLabel={quotation.number}
                onClose={() => setRequesting(false)}
                onRequested={() => { setRequesting(false); detail.reload(); }}
              />
            ) : null}

            {promptDialog}
          </>
        ) : null}
      </div>
    </div>
  );
}



/**
 * Revising after a discussion.
 *
 * Opens with the current lines so the change is an adjustment rather than a retype, and
 * requires a note saying what moved — six months later, "why is r3 cheaper than r2" is
 * the question, and the answer has to be somewhere.
 */
function ReviseQuotation({
  quotation, onClose, onRevised,
}: { quotation: any; onClose: () => void; onRevised: () => void }) {
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(
    (quotation.lines ?? []).map((line: any) => ({
      description: line.description,
      quantity: String(Number(line.quantity)),
      unitPrice: String(Number(line.unit_price)),
      taxRate: String(Number(line.tax_rate)),
    })),
  );
  const [terms, setTerms] = useState(quotation.terms ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const total = useMemo(
    () => lines.reduce((sum, line) => {
      const amount = Number(line.quantity || 0) * Number(line.unitPrice || 0);
      return sum + amount + (amount * Number(line.taxRate || 0)) / 100;
    }, 0),
    [lines],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(`/quotations/${quotation.id}/revise`, {
        note,
        terms: terms || null,
        lines: lines.filter((l) => l.description.trim()).map((l) => ({
          description: l.description.trim(),
          quantity: Number(l.quantity || 1),
          unitPrice: Number(l.unitPrice || 0),
          taxRate: Number(l.taxRate || 0),
        })),
      });
      onRevised();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That revision could not be created');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog dialog-wide" role="dialog" aria-label="Revise quotation"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Revise {quotation.number}</h3>
        <p className="field-hint">
          This creates a new revision and supersedes the current one. Signatures do not
          carry across — the new figures have to be agreed again.
        </p>

        <label className="field">
          <span>What changed, and why</span>
          <textarea rows={2} value={note} required minLength={4}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Client asked to drop the training days and stage the payments." />
        </label>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Description</th><th style={{ width: 90 }}>Qty</th>
                  <th style={{ width: 130 }}>Unit price</th><th style={{ width: 90 }}>Tax %</th><th /></tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td><input value={line.description}
                             onChange={(e) => setLine(index, { description: e.target.value })} /></td>
                  <td><input type="number" min="0" step="0.001" value={line.quantity}
                             onChange={(e) => setLine(index, { quantity: e.target.value })} /></td>
                  <td><input type="number" min="0" step="0.01" value={line.unitPrice}
                             onChange={(e) => setLine(index, { unitPrice: e.target.value })} /></td>
                  <td><input type="number" min="0" max="100" step="0.01" value={line.taxRate}
                             onChange={(e) => setLine(index, { taxRate: e.target.value })} /></td>
                  <td>
                    {lines.length > 1 ? (
                      <button type="button" className="ghost-button"
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
          <dt>Was</dt><dd>{Number(quotation.total).toFixed(2)}</dd>
          <dt><strong>Now</strong></dt><dd><strong>{total.toFixed(2)}</strong></dd>
        </dl>

        <label className="field">
          <span>Terms</span>
          <textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || note.trim().length < 4}>
            {saving ? 'Creating…' : 'Create revision'}
          </button>
        </div>
      </form>
    </div>
  );
}

