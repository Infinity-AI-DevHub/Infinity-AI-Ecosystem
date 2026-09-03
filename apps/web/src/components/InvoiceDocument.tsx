import { SignatureBlocks, type SignatureState } from './DocumentSigning';
import { useLogoUrl } from '../lib/logo';

/**
 * The invoice and receipt as the client sees them.
 *
 * One component renders both the on-screen preview and what is printed, so what somebody
 * approves is what the client receives. A preview drawn separately from the document is
 * a preview that can lie.
 *
 * Everything configurable comes from billing settings; nothing is hardcoded except the
 * structure, because a company's letterhead is not a code change.
 */
export type BillingProfile = {
  legal_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  tax_registration: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  payment_instructions: string | null;
  invoice_footer: string | null;
  receipt_footer: string | null;
  logo_file_id?: string | null;
  accent_colour: string | null;
};

type Line = {
  id?: string;
  description: string;
  quantity: string | number;
  unit_price: string | number;
  tax_rate: string | number;
  amount: string | number;
};

type Payment = {
  id: string;
  amount: string | number;
  paid_on: string;
  method: string;
  reference: string | null;
  receipt_number: string | null;
};

export type InvoiceForDocument = {
  number: string;
  status: string;
  currency: string;
  issue_date: string;
  due_date: string;
  subtotal: string | number;
  tax_amount: string | number;
  total: string | number;
  amount_paid: string | number;
  balance?: string | number;
  notes: string | null;
  terms: string | null;
  client_name: string;
  project_name: string | null;
  representative: string | null;
  billing_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  tax_registration: string | null;
  lines?: Line[];
  payments?: Payment[];
};

// Grouped digits without the currency code, for the columns where the totals below
// already state it. A line reading 450000.00 beside a total reading LKR 450,000.00
// looks like two different numbers.
const amount = (value: string | number | undefined) =>
  Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const money = (value: string | number | undefined, currency: string) =>
  `${currency} ${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const addressLines = (source: {
  address_line1: string | null; address_line2: string | null;
  city: string | null; postal_code: string | null; country: string | null;
}) => [source.address_line1, source.address_line2,
       [source.city, source.postal_code].filter(Boolean).join(' '),
       source.country].filter((part) => part && String(part).trim().length > 0) as string[];

export function InvoiceDocument({
  invoice,
  profile,
  variant = 'invoice',
  payment,
  signatures,
  requiredRoles,
}: {
  invoice: InvoiceForDocument;
  profile: BillingProfile;
  /** A receipt is the same document acknowledging one payment rather than requesting money. */
  variant?: 'invoice' | 'receipt';
  payment?: Payment;
  /** Omitted on a preview that has no signature state to show yet. */
  signatures?: SignatureState['signatures'];
  requiredRoles?: string[];
}) {
  const accent = profile.accent_colour || '#1A6288';
  const isReceipt = variant === 'receipt';
  const logoUrl = useLogoUrl(profile.logo_file_id);
  const balance = Number(invoice.total) - Number(invoice.amount_paid);

  return (
    <article className="doc-sheet" style={{ ['--doc-accent' as string]: accent }}>
      <header className="doc-head">
        <div>
          {logoUrl ? <img className="doc-logo" src={logoUrl} alt="" /> : null}
          <h1 className="doc-title">{isReceipt ? 'Receipt' : 'Invoice'}</h1>
          <p className="doc-number">
            {isReceipt ? payment?.receipt_number ?? '—' : invoice.number}
          </p>
          {isReceipt ? (
            <p className="doc-sub">for invoice {invoice.number}</p>
          ) : null}
        </div>
        <div className="doc-from">
          <strong>{profile.legal_name ?? 'Your company'}</strong>
          {addressLines(profile).map((line) => <span key={line}>{line}</span>)}
          {profile.tax_registration ? <span>Tax reg. {profile.tax_registration}</span> : null}
          {profile.contact_email ? <span>{profile.contact_email}</span> : null}
          {profile.contact_phone ? <span>{profile.contact_phone}</span> : null}
        </div>
      </header>

      <section className="doc-parties">
        <div>
          <span className="doc-label">{isReceipt ? 'Received from' : 'Billed to'}</span>
          <strong>{invoice.client_name}</strong>
          {invoice.representative ? <span>{invoice.representative}</span> : null}
          {addressLines(invoice).map((line) => <span key={line}>{line}</span>)}
          {invoice.tax_registration ? <span>Tax reg. {invoice.tax_registration}</span> : null}
          {invoice.billing_email ? <span>{invoice.billing_email}</span> : null}
        </div>
        <dl className="doc-dates">
          {isReceipt ? (
            <>
              <dt>Payment date</dt>
              <dd>{String(payment?.paid_on ?? '').slice(0, 10)}</dd>
              <dt>Method</dt>
              <dd>{(payment?.method ?? '').replace('_', ' ')}</dd>
              {payment?.reference ? (<><dt>Reference</dt><dd>{payment.reference}</dd></>) : null}
            </>
          ) : (
            <>
              <dt>Issued</dt><dd>{String(invoice.issue_date).slice(0, 10)}</dd>
              <dt>Due</dt><dd>{String(invoice.due_date).slice(0, 10)}</dd>
            </>
          )}
          {invoice.project_name ? (<><dt>Project</dt><dd>{invoice.project_name}</dd></>) : null}
        </dl>
      </section>

      {isReceipt ? (
        <div className="doc-receipt-amount">
          <span className="doc-label">Amount received</span>
          <strong>{money(payment?.amount, invoice.currency)}</strong>
        </div>
      ) : (
        <table className="doc-lines">
          <thead>
            <tr>
              <th>Description</th>
              <th className="doc-num">Qty</th>
              <th className="doc-num">Unit price</th>
              <th className="doc-num">Tax</th>
              <th className="doc-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.lines ?? []).map((line, index) => (
              <tr key={line.id ?? index}>
                <td>{line.description}</td>
                <td className="doc-num">{Number(line.quantity)}</td>
                <td className="doc-num">{amount(line.unit_price)}</td>
                <td className="doc-num">{Number(line.tax_rate) > 0 ? `${Number(line.tax_rate)}%` : '—'}</td>
                <td className="doc-num">{amount(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="doc-totals">
        {!isReceipt ? (
          <>
            <div><span>Subtotal</span><span>{money(invoice.subtotal, invoice.currency)}</span></div>
            {Number(invoice.tax_amount) > 0 ? (
              <div><span>Tax</span><span>{money(invoice.tax_amount, invoice.currency)}</span></div>
            ) : null}
            <div className="doc-total-row">
              <span>Total</span><span>{money(invoice.total, invoice.currency)}</span>
            </div>
            {Number(invoice.amount_paid) > 0 ? (
              <>
                <div><span>Paid</span><span>−{money(invoice.amount_paid, invoice.currency)}</span></div>
                <div className="doc-total-row">
                  <span>Balance due</span><span>{money(balance, invoice.currency)}</span>
                </div>
              </>
            ) : null}
          </>
        ) : (
          <div className="doc-total-row">
            <span>Balance remaining</span><span>{money(balance, invoice.currency)}</span>
          </div>
        )}
      </div>

      {!isReceipt && profile.payment_instructions ? (
        <section className="doc-block">
          <span className="doc-label">How to pay</span>
          <p>{profile.payment_instructions}</p>
        </section>
      ) : null}

      {!isReceipt && invoice.terms ? (
        <section className="doc-block">
          <span className="doc-label">Terms</span>
          <p>{invoice.terms}</p>
        </section>
      ) : null}

      {!isReceipt && invoice.notes ? (
        <section className="doc-block"><p>{invoice.notes}</p></section>
      ) : null}

      {requiredRoles && requiredRoles.length > 0 ? (
        <SignatureBlocks required={requiredRoles} signatures={signatures ?? []} />
      ) : null}

      {(isReceipt ? profile.receipt_footer : profile.invoice_footer) ? (
        <footer className="doc-footer">
          {isReceipt ? profile.receipt_footer : profile.invoice_footer}
        </footer>
      ) : null}
    </article>
  );
}
