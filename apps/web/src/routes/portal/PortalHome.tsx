/**
 * What a client sees first.
 *
 * The one question a client actually arrives with is "what do I owe and by when", so that
 * is the top of the page and everything else is secondary. Nothing here is a total across
 * the company — every figure comes from the portal endpoints, which are scoped to this
 * organisation in SQL.
 */
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, CreditCard, FileText, FolderOpen, Megaphone, Receipt, Upload,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { AsyncSection } from '../../components/States';
import { formatCurrency, formatDate } from '../../lib/format';

type Overview = {
  organisation: { id: string; name: string; contact_name: string | null };
  invoices: { outstanding: number; open: number; overdue: number };
  quotationsAwaiting: number;
  shared: { files: number; tasks: number; pages: number };
};

export function PortalHome() {
  const overview = useQuery<Overview>('/portal/overview', (signal) =>
    api.get('/portal/overview', signal),
  );

  return (
    <AsyncSection query={overview}>
      {(data) => (
        <>
          <header className="portal-head">
            <h1>{data.organisation.name}</h1>
            <p>Your invoices, quotations and shared work with Infinity AI.</p>
          </header>

          <section className="portal-figures" aria-label="Summary">
            <article className={`portal-figure ${data.invoices.overdue > 0 ? 'is-overdue' : ''}`}>
              <span className="portal-figure-label">Outstanding</span>
              <strong className="portal-figure-value">
                {formatCurrency(data.invoices.outstanding, 'LKR')}
              </strong>
              <span className="field-hint">
                {data.invoices.open === 0
                  ? 'Nothing outstanding — thank you.'
                  : `${data.invoices.open} unpaid ${data.invoices.open === 1 ? 'invoice' : 'invoices'}`}
              </span>
              {data.invoices.overdue > 0 ? (
                <span className="portal-overdue">
                  <AlertTriangle size={13} aria-hidden="true" />
                  {data.invoices.overdue} past its due date
                </span>
              ) : null}
            </article>

            <Link to="/portal/quotations" className="portal-figure portal-figure-link">
              <span className="portal-figure-label">Quotations</span>
              <strong className="portal-figure-value">{data.quotationsAwaiting}</strong>
              <span className="field-hint">
                {data.quotationsAwaiting === 0
                  ? 'Nothing waiting on you'
                  : 'Awaiting your response'}
              </span>
            </Link>

            <Link to="/portal/documents" className="portal-figure portal-figure-link">
              <span className="portal-figure-label">Shared with you</span>
              <strong className="portal-figure-value">
                {data.shared.files + data.shared.pages}
              </strong>
              <span className="field-hint">documents and files</span>
            </Link>
          </section>

          <RecentNotices />

          <nav className="portal-jump" aria-label="Sections">
            <Link to="/portal/invoices" className="portal-jump-card">
              <Receipt size={18} aria-hidden="true" />
              <span><strong>Invoices</strong>Everything billed to you, with what has been paid.</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link to="/portal/quotations" className="portal-jump-card">
              <FileText size={18} aria-hidden="true" />
              <span><strong>Quotations</strong>Proposals we have sent, and what they cover.</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link to="/portal/payments" className="portal-jump-card">
              <CreditCard size={18} aria-hidden="true" />
              <span><strong>Payments &amp; receipts</strong>Due dates, recorded payments and downloadable receipts.</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link to="/portal/documents" className="portal-jump-card">
              <FolderOpen size={18} aria-hidden="true" />
              <span><strong>Documents</strong>Files and pages shared with you by the team.</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link to="/portal/send" className="portal-jump-card">
              <Upload size={18} aria-hidden="true" />
              <span><strong>Send us a document</strong>Upload an invoice, remittance advice or requested file.</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </nav>
        </>
      )}
    </AsyncSection>
  );
}

/**
 * The latest notices, on the page a client actually lands on.
 *
 * There is a Notices page, but a notice nobody opens is not a notice — the point of
 * telling a client something is that they see it without going looking. Only the two
 * most recent, so the overview stays an overview.
 */
function RecentNotices() {
  const notices = useQuery<{ items: Notice[] }>('/portal/notices', (signal) =>
    api.get('/portal/notices', signal),
  );

  const items = notices.data?.items ?? [];
  // Nothing at all rather than an empty box: a client with no notices should not be
  // shown a permanent reminder that there are none.
  if (items.length === 0) return null;

  return (
    <section className="portal-notice-strip" aria-label="Notices">
      <header>
        <h2><Megaphone size={15} aria-hidden="true" /> Notices</h2>
        {items.length > 2 ? <Link to="/portal/notices">See all {items.length}</Link> : null}
      </header>
      <ul className="portal-notice-list">
        {items.slice(0, 2).map((notice) => (
          <li key={notice.id} className={`portal-notice priority-${notice.priority}`}>
            <Megaphone size={15} aria-hidden="true" />
            <div>
              <strong>{notice.title}</strong>
              <span className="field-hint">{formatDate(notice.publish_at)}</span>
              <p className="portal-notice-body">{notice.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Notice = {
  id: string; title: string; body: string; priority: string; publish_at: string;
};
