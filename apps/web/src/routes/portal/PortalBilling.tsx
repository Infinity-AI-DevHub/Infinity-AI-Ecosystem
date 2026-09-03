/**
 * Money, from the client's side.
 *
 * Three questions in one place: what is owed, what has already been paid, and what you
 * need to send us. They were three different conversations by email before this.
 */
import { useState } from 'react';
import { AlertTriangle, CalendarClock, Download, Eye, Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { AsyncSection, Empty } from '../../components/States';
import { formatCurrency, formatDate } from '../../lib/format';
import { EvidenceUpload, type AttachedFile } from '../../components/EvidenceUpload';
import { FilePreview, type PreviewTarget } from '../../components/FilePreview';
import { downloadPortalDocumentPdf, openPortalDocumentPdf } from '../../lib/documents-pdf';

type Payment = {
  id: string; amount: number; paid_on: string; method: string | null;
  reference: string | null; receipt_number: string | null;
  invoice_number: string; currency: string;
};

type NextPayment = {
  id: string; number: string; dueDate: string; currency: string;
  amount: number; daysAway: number; overdue: boolean;
} | null;

type Upload = {
  id: string; file_id: string; name: string; kind: string; note: string | null;
  status: string; review_note: string | null; created_at: string;
  mime_type: string | null; size_bytes: number;
};

const KIND_WORDS: Record<string, string> = {
  invoice: 'Invoice',
  payment_proof: 'Proof of payment',
  other: 'Document',
};

const STATUS_WORDS: Record<string, string> = {
  received: 'Received',
  accepted: 'Accepted',
  rejected: 'Not accepted',
};

export function PortalPayments() {
  const [pdfError, setPdfError] = useState<string | null>(null);
  const next = useQuery<{ next: NextPayment }>('/portal/next-payment', (signal) =>
    api.get('/portal/next-payment', signal),
  );
  const payments = useQuery<{ items: Payment[] }>('/portal/payments', (signal) =>
    api.get('/portal/payments', signal),
  );

  return (
    <>
      <header className="portal-head">
        <h1>Payments</h1>
        <p>What is due next, and everything we have received.</p>
      </header>

      <AsyncSection query={next}>
        {(data) =>
          data.next ? (
            <article className={`portal-due ${data.next.overdue ? 'is-overdue' : ''}`}>
              <CalendarClock size={18} aria-hidden="true" />
              <div>
                <span className="portal-figure-label">
                  {data.next.overdue ? 'Overdue' : 'Next payment'}
                </span>
                <strong className="portal-due-amount">
                  {formatCurrency(data.next.amount, data.next.currency)}
                </strong>
                <span className="field-hint">
                  {data.next.number} ·{' '}
                  {data.next.overdue
                    ? `was due ${formatDate(data.next.dueDate)}, ${Math.abs(data.next.daysAway)} days ago`
                    : data.next.daysAway === 0
                      ? `due today, ${formatDate(data.next.dueDate)}`
                      : `due ${formatDate(data.next.dueDate)}, in ${data.next.daysAway} days`}
                </span>
              </div>
              {data.next.overdue ? <AlertTriangle size={16} aria-hidden="true" /> : null}
            </article>
          ) : (
            <p className="field-hint portal-due-none">Nothing is due at the moment.</p>
          )
        }
      </AsyncSection>

      <section className="portal-doc-block">
        <h2>Payments received</h2>
        <AsyncSection query={payments}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty
                title="No payments recorded yet"
                description="Payments appear here once we have logged them against an invoice."
              />
            ) : (
              <div className="portal-table-wrap">
                <table className="data-table portal-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Invoice</th>
                      <th scope="col">Method</th>
                      <th scope="col">Reference</th>
                      <th scope="col" className="num">Amount</th>
                      <th scope="col">Receipt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((payment) => (
                      <tr key={payment.id}>
                        <th scope="row">{formatDate(payment.paid_on)}</th>
                        <td>{payment.invoice_number}</td>
                        <td>{payment.method ?? '—'}</td>
                        <td>{payment.reference ?? payment.receipt_number ?? '—'}</td>
                        <td className="num">
                          {formatCurrency(payment.amount, payment.currency)}
                        </td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => {
                              setPdfError(null);
                              void openPortalDocumentPdf('receipt', payment.id)
                                .catch(() => setPdfError('The receipt could not be opened.'));
                            }}
                          >
                            <Eye size={14} aria-hidden="true" /> View
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => {
                              setPdfError(null);
                              const name = payment.receipt_number || `receipt-${payment.id.slice(0, 8)}`;
                              void downloadPortalDocumentPdf('receipt', payment.id, `${name}.pdf`)
                                .catch(() => setPdfError('The receipt could not be downloaded.'));
                            }}
                          >
                            <Download size={14} aria-hidden="true" /> Download
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
        {pdfError ? <p className="field-error" role="alert">{pdfError}</p> : null}
      </section>
    </>
  );
}

/**
 * Where a client sends something back.
 *
 * The file goes through the ordinary upload path first and is only then recorded against
 * their organisation, so nothing reaches us that has not been scanned and counted.
 */
export function PortalSend() {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [kind, setKind] = useState<'invoice' | 'payment_proof' | 'other'>('invoice');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null);

  const uploads = useQuery<{ items: Upload[] }>('/portal/uploads', (signal) =>
    api.get('/portal/uploads', signal),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (files.length === 0) {
      setError('Attach the document first.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      for (const file of files) {
        await api.post('/portal/uploads', {
          fileId: file.id,
          kind,
          note: note.trim() || null,
        });
      }
      setFiles([]);
      setNote('');
      setSent(true);
      invalidate('/portal/uploads');
      uploads.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="portal-head">
        <h1>Send us a document</h1>
        <p>Your invoice, proof of a payment, or anything else we have asked for.</p>
      </header>

      <form className="portal-send" onSubmit={submit}>
        <fieldset className="field">
          <legend className="label-row">What is it?</legend>
          <div className="portal-kinds">
            {(['invoice', 'payment_proof', 'other'] as const).map((value) => (
              <label key={value} className={`choice ${kind === value ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                {KIND_WORDS[value]}
              </label>
            ))}
          </div>
        </fieldset>

        <EvidenceUpload
          files={files}
          onChange={(next) => { setFiles(next); setSent(false); }}
          label="The document"
          hint="PDFs, images or scans."
          uploadOptions={{ purpose: 'portal_submission' }}
        />

        <label className="field">
          <span>Anything we should know? (optional)</span>
          <textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Which invoice this relates to, a reference number…"
          />
        </label>

        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {sent ? (
          <p className="portal-sent" role="status">
            Thank you — we have it. Someone will pick it up.
          </p>
        ) : null}

        <button type="submit" className="primary-button" disabled={busy}>
          <Upload size={15} aria-hidden="true" /> {busy ? 'Sending…' : 'Send it'}
        </button>
      </form>

      <section className="portal-doc-block">
        <h2>What you have sent us</h2>
        <AsyncSection query={uploads}>
          {(data) =>
            data.items.length === 0 ? (
              <p className="field-hint">Nothing yet.</p>
            ) : (
              <ul className="portal-upload-list">
                {data.items.map((upload) => (
                  <li key={upload.id}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setPreviewing({
                        fileId: upload.file_id, name: upload.name,
                        mimeType: upload.mime_type, sizeBytes: upload.size_bytes,
                      })}
                    >
                      {upload.name}
                    </button>
                    <span className="field-hint">
                      {KIND_WORDS[upload.kind] ?? upload.kind} · sent {formatDate(upload.created_at)}
                    </span>
                    <span className={`status-tag ${
                      upload.status === 'accepted' ? 'status-active'
                        : upload.status === 'rejected' ? 'status-error' : 'status-pending'}`}>
                      {STATUS_WORDS[upload.status] ?? upload.status}
                    </span>
                    {upload.review_note ? (
                      <span className="field-hint portal-upload-note">{upload.review_note}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncSection>
      </section>

      {previewing ? (
        <FilePreview target={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
    </>
  );
}
