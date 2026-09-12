/**
 * "Kasun asked you to sign INV-2026-0014."
 *
 * Sits at the top of the dashboard and of Finance, because a signature request is a
 * thing that blocks somebody else's work — it should not wait to be discovered in a
 * notification list. It renders nothing at all when there is nothing waiting, so it
 * costs a person who has been asked for nothing exactly no attention.
 */
import { Link } from 'react-router-dom';
import { PenLine } from 'lucide-react';
import { api } from '../lib/api';
import { useQuery } from '../lib/query';
import { relativeTime } from '../lib/format';

type Request = {
  id: string;
  documentType: string;
  documentId: string;
  documentLabel: string;
  note: string | null;
  requestedBy: string;
  requestedAt: string;
};

export function SignatureRequests() {
  const requests = useQuery<{ items: Request[] }>('/signatures/requests', (signal) =>
    api.get('/signatures/requests', signal),
  );

  const items = requests.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <section className="signature-requests" aria-label="Waiting for your signature">
      {items.map((request) => (
        <article key={request.id} className="signature-request">
          <PenLine size={16} aria-hidden="true" />
          <div>
            <strong>
              {request.requestedBy} asked you to sign {request.documentLabel}
            </strong>
            <span className="field-hint">
              {relativeTime(request.requestedAt)}
              {request.note ? ` · “${request.note}”` : ''}
            </span>
          </div>
          <Link
            className="primary-button"
            to={`/finance?tab=${request.documentType === 'quotation' ? 'quotations' : 'invoices'}&open=${request.documentId}`}
          >
            Review and sign
          </Link>
        </article>
      ))}
    </section>
  );
}
