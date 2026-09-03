/**
 * The client's invoices and quotations.
 *
 * One file because they are the same screen with different nouns: a list of documents
 * addressed to this organisation, and a detail view with lines and a total. Splitting
 * them would duplicate the table, the money formatting and the empty states.
 */
import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Download, Eye } from 'lucide-react';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { AsyncSection, Empty } from '../../components/States';
import { formatCurrency, formatDate } from '../../lib/format';
import { FilePreview, type PreviewTarget } from '../../components/FilePreview';
import { downloadPortalDocumentPdf, openPortalDocumentPdf } from '../../lib/documents-pdf';

type Invoice = {
  id: string; number: string; status: string; currency: string;
  issue_date: string; due_date: string | null;
  total: number; amount_paid: number; outstanding: number;
  signed_copy_file_id: string | null;
};

type Line = {
  description: string; quantity: number; unit_price: number; tax_rate: number; amount: number;
};

/** A client reads "Open"; the system stores "open". They also read intent, not state. */
const STATUS_WORDS: Record<string, string> = {
  open: 'Awaiting payment',
  partially_paid: 'Part paid',
  paid: 'Paid',
  void: 'Cancelled',
  sent: 'Awaiting your response',
  accepted: 'Accepted',
  declined: 'Declined',
};

const STATUS_TONE: Record<string, string> = {
  paid: 'status-active',
  accepted: 'status-active',
  open: 'status-pending',
  sent: 'status-pending',
  partially_paid: 'status-pending',
  void: 'status-error',
  declined: 'status-error',
};

function overdue(invoice: Invoice): boolean {
  if (!invoice.due_date || invoice.outstanding <= 0) return false;
  return new Date(invoice.due_date) < new Date();
}

export function PortalInvoices() {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery<{ items: Invoice[] }>('/portal/invoices', (signal) =>
    api.get('/portal/invoices', signal),
  );

  if (openId) {
    return <DocumentDetail kind="invoices" id={openId} onBack={() => setOpenId(null)} />;
  }

  return (
    <>
      <header className="portal-head">
        <h1>Invoices</h1>
        <p>Everything we have billed you for, and what is still outstanding.</p>
      </header>

      <AsyncSection query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty
              title="No invoices yet"
              description="Invoices appear here as soon as we send them."
            />
          ) : (
            <div className="portal-table-wrap">
              <table className="data-table portal-table">
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Issued</th>
                    <th scope="col">Due</th>
                    <th scope="col" className="num">Total</th>
                    <th scope="col" className="num">Outstanding</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((invoice) => (
                    <tr key={invoice.id}>
                      <th scope="row">
                        <button type="button" className="link-button"
                                onClick={() => setOpenId(invoice.id)}>
                          {invoice.number}
                        </button>
                      </th>
                      <td>{formatDate(invoice.issue_date)}</td>
                      <td className={overdue(invoice) ? 'is-overdue-cell' : ''}>
                        {invoice.due_date ? formatDate(invoice.due_date) : '—'}
                        {overdue(invoice) ? (
                          <AlertTriangle size={12} aria-label="Overdue" />
                        ) : null}
                      </td>
                      <td className="num">{formatCurrency(invoice.total, invoice.currency)}</td>
                      <td className="num">
                        {formatCurrency(invoice.outstanding, invoice.currency)}
                      </td>
                      <td>
                        <span className={`status-tag ${STATUS_TONE[invoice.status] ?? 'status-pending'}`}>
                          {STATUS_WORDS[invoice.status] ?? invoice.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </AsyncSection>
    </>
  );
}

export function PortalQuotations() {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery<{ items: (Invoice & { summary: string | null; valid_until: string | null })[] }>(
    '/portal/quotations',
    (signal) => api.get('/portal/quotations', signal),
  );

  if (openId) {
    return <DocumentDetail kind="quotations" id={openId} onBack={() => setOpenId(null)} />;
  }

  return (
    <>
      <header className="portal-head">
        <h1>Quotations</h1>
        <p>Proposals we have sent you.</p>
      </header>

      <AsyncSection query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty title="No quotations yet" description="They appear here once we send them." />
          ) : (
            <ul className="portal-quote-list">
              {data.items.map((quote) => (
                <li key={quote.id}>
                  <button type="button" className="portal-quote" onClick={() => setOpenId(quote.id)}>
                    <span className="portal-quote-head">
                      <strong>{quote.number}</strong>
                      <span className={`status-tag ${STATUS_TONE[quote.status] ?? 'status-pending'}`}>
                        {STATUS_WORDS[quote.status] ?? quote.status}
                      </span>
                    </span>
                    {quote.summary ? <span className="portal-quote-sum">{quote.summary}</span> : null}
                    <span className="field-hint">
                      {formatCurrency(quote.total, quote.currency)}
                      {quote.valid_until ? ` · valid until ${formatDate(quote.valid_until)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </AsyncSection>
    </>
  );
}

/** The shared detail view: header figures, the lines, and the signed copy if there is one. */
function DocumentDetail({
  kind, id, onBack,
}: { kind: 'invoices' | 'quotations'; id: string; onBack: () => void }) {
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const pdfKind = kind === 'invoices' ? 'invoice' : 'quotation';
  const detail = useQuery<Invoice & {
    lines: Line[];
    payments?: { amount: number; paid_on: string; method: string | null; reference: string | null }[];
    notes?: string | null; terms?: string | null; summary?: string | null;
    valid_until?: string | null;
  }>(`/portal/${kind}/${id}`, (signal) => api.get(`/portal/${kind}/${id}`, signal));

  return (
    <>
      <button type="button" className="ghost-button portal-back" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" /> Back
      </button>

      <AsyncSection query={detail}>
        {(doc) => (
          <article className="portal-doc">
            <header className="portal-doc-head">
              <div>
                <h1>{doc.number}</h1>
                <p className="field-hint">
                  Issued {formatDate(doc.issue_date)}
                  {doc.due_date ? ` · due ${formatDate(doc.due_date)}` : ''}
                  {doc.valid_until ? ` · valid until ${formatDate(doc.valid_until)}` : ''}
                </p>
              </div>
              <div className="portal-document-actions">
                <span className={`status-tag ${STATUS_TONE[doc.status] ?? 'status-pending'}`}>
                  {STATUS_WORDS[doc.status] ?? doc.status}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setPdfError(null);
                    void openPortalDocumentPdf(pdfKind, doc.id)
                      .catch(() => setPdfError('The PDF could not be opened.'));
                  }}
                >
                  <Eye size={14} aria-hidden="true" /> View PDF
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setPdfError(null);
                    void downloadPortalDocumentPdf(pdfKind, doc.id, `${doc.number}.pdf`)
                      .catch(() => setPdfError('The PDF could not be downloaded.'));
                  }}
                >
                  <Download size={14} aria-hidden="true" /> Download PDF
                </button>
              </div>
            </header>

            {pdfError ? <p className="field-error" role="alert">{pdfError}</p> : null}

            {doc.summary ? <p className="portal-doc-summary">{doc.summary}</p> : null}

            <div className="portal-table-wrap">
              <table className="data-table portal-table">
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col" className="num">Qty</th>
                    <th scope="col" className="num">Unit price</th>
                    <th scope="col" className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lines.map((line, index) => (
                    <tr key={index}>
                      <th scope="row">{line.description}</th>
                      <td className="num">{Number(line.quantity)}</td>
                      <td className="num">{formatCurrency(Number(line.unit_price), doc.currency)}</td>
                      <td className="num">{formatCurrency(Number(line.amount), doc.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={3}>Total</th>
                    <td className="num"><strong>{formatCurrency(doc.total, doc.currency)}</strong></td>
                  </tr>
                  {kind === 'invoices' && doc.amount_paid > 0 ? (
                    <>
                      <tr>
                        <th scope="row" colSpan={3}>Paid</th>
                        <td className="num">{formatCurrency(doc.amount_paid, doc.currency)}</td>
                      </tr>
                      <tr>
                        <th scope="row" colSpan={3}>Outstanding</th>
                        <td className="num">
                          <strong>{formatCurrency(doc.outstanding, doc.currency)}</strong>
                        </td>
                      </tr>
                    </>
                  ) : null}
                </tfoot>
              </table>
            </div>

            {doc.payments && doc.payments.length > 0 ? (
              <section className="portal-doc-block">
                <h2>Payments received</h2>
                <ul className="portal-payments">
                  {doc.payments.map((payment, index) => (
                    <li key={index}>
                      <strong>{formatCurrency(Number(payment.amount), doc.currency)}</strong>
                      <span className="field-hint">
                        {formatDate(payment.paid_on)}
                        {payment.method ? ` · ${payment.method}` : ''}
                        {payment.reference ? ` · ${payment.reference}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {doc.terms ? (
              <section className="portal-doc-block">
                <h2>Terms</h2>
                <p className="portal-doc-terms">{doc.terms}</p>
              </section>
            ) : null}

            {doc.signed_copy_file_id ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => setPreviewing({
                  fileId: doc.signed_copy_file_id!,
                  name: `${doc.number}.pdf`,
                  mimeType: 'application/pdf',
                  sizeBytes: 0,
                })}
              >
                <Download size={14} aria-hidden="true" /> Open the signed copy
              </button>
            ) : null}

            {previewing ? (
              <FilePreview target={previewing} onClose={() => setPreviewing(null)} />
            ) : null}
          </article>
        )}
      </AsyncSection>
    </>
  );
}
