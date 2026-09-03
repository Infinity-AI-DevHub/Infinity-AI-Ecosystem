/**
 * The quotation as the prospect receives it, including its signature blocks.
 *
 * Signature slots are drawn whether or not they are filled, because an unsigned slot on
 * a document is information: it shows the reader what is still outstanding rather than
 * leaving them to guess.
 */
import type { BillingProfile } from './InvoiceDocument';

export type QuotationSignature = {
  role: string;
  signer_name: string;
  signed_at: string;
  valid: boolean;
  imageUrl?: string | null;
};

export type QuotationForDocument = {
  number: string;
  currency: string;
  issue_date: string;
  valid_until: string | null;
  subtotal: string | number;
  tax_amount: string | number;
  total: string | number;
  summary: string | null;
  terms: string | null;
  org_name: string;
  representative: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  lines?: { id?: string; description: string; quantity: string | number;
            unit_price: string | number; tax_rate: string | number; amount: string | number }[];
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
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const ROLE_LABEL: Record<string, string> = {
  internal_1: 'For Infinity AI',
  internal_2: 'For Infinity AI',
  client_1: 'For the client',
  client_2: 'For the client',
};

export function QuotationDocument({
  quotation,
  profile,
  signatures = [],
  requiredRoles = ['internal_1', 'internal_2', 'client_1'],
}: {
  quotation: QuotationForDocument;
  profile: BillingProfile;
  signatures?: QuotationSignature[];
  requiredRoles?: string[];
}) {
  const accent = profile.accent_colour || '#1A6288';
  const address = [quotation.address_line1, quotation.address_line2,
    [quotation.city, quotation.postal_code].filter(Boolean).join(' '),
    quotation.country].filter((part) => part && String(part).trim()) as string[];

  return (
    <article className="doc-sheet" style={{ ['--doc-accent' as string]: accent }}>
      <header className="doc-head">
        <div>
          <h1 className="doc-title">Quotation</h1>
          <p className="doc-number">{quotation.number}</p>
        </div>
        <div className="doc-from">
          <strong>{profile.legal_name ?? 'Your company'}</strong>
          {[profile.address_line1, profile.city, profile.country]
            .filter(Boolean).map((line) => <span key={String(line)}>{line}</span>)}
          {profile.contact_email ? <span>{profile.contact_email}</span> : null}
        </div>
      </header>

      <section className="doc-parties">
        <div>
          <span className="doc-label">Prepared for</span>
          <strong>{quotation.org_name}</strong>
          {quotation.representative ? <span>{quotation.representative}</span> : null}
          {address.map((line) => <span key={line}>{line}</span>)}
        </div>
        <dl className="doc-dates">
          <dt>Issued</dt><dd>{String(quotation.issue_date).slice(0, 10)}</dd>
          {quotation.valid_until ? (
            <><dt>Valid until</dt><dd>{String(quotation.valid_until).slice(0, 10)}</dd></>
          ) : null}
        </dl>
      </section>

      {quotation.summary ? (
        <section className="doc-block"><p>{quotation.summary}</p></section>
      ) : null}

      <table className="doc-lines">
        <thead>
          <tr>
            <th>Description</th><th className="doc-num">Qty</th>
            <th className="doc-num">Unit price</th><th className="doc-num">Tax</th>
            <th className="doc-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {(quotation.lines ?? []).map((line, index) => (
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

      <div className="doc-totals">
        <div><span>Subtotal</span><span>{money(quotation.subtotal, quotation.currency)}</span></div>
        {Number(quotation.tax_amount) > 0 ? (
          <div><span>Tax</span><span>{money(quotation.tax_amount, quotation.currency)}</span></div>
        ) : null}
        <div className="doc-total-row">
          <span>Total</span><span>{money(quotation.total, quotation.currency)}</span>
        </div>
      </div>

      {quotation.terms ? (
        <section className="doc-block">
          <span className="doc-label">Terms</span>
          <p>{quotation.terms}</p>
        </section>
      ) : null}

      <section className="doc-signatures">
        {requiredRoles.map((role, index) => {
          const signature = signatures.find((s) => s.role === role);
          return (
            <div className="doc-sig-slot" key={role}>
              {signature?.imageUrl ? (
                <img src={signature.imageUrl} alt={`Signature of ${signature.signer_name}`} />
              ) : (
                <span className="doc-sig-blank" aria-hidden="true" />
              )}
              <span className="doc-sig-rule" />
              <span className="doc-sig-role">
                {ROLE_LABEL[role] ?? role}
                {requiredRoles.filter((r) => ROLE_LABEL[r] === ROLE_LABEL[role]).length > 1
                  ? ` (${role.endsWith('_2') ? 'second' : 'first'})`
                  : ''}
              </span>
              {signature ? (
                <>
                  <span className="doc-sig-name">{signature.signer_name}</span>
                  <span className="doc-sig-date">
                    {String(signature.signed_at).slice(0, 10)}
                    {/* A broken signature is stated on the document itself, not only in
                        the application: whoever reads the paper should see it too. */}
                    {!signature.valid ? ' · document changed after signing' : ''}
                  </span>
                </>
              ) : (
                <span className="doc-sig-date">Not yet signed</span>
              )}
              {index === requiredRoles.length - 1 ? null : null}
            </div>
          );
        })}
      </section>
    </article>
  );
}
