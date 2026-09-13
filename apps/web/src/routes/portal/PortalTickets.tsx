/**
 * Support requests for a client.
 *
 * A client sees every request raised by anyone at their organisation, and only the public
 * side of each: replies addressed to them, never the notes colleagues leave for each
 * other. Internal queue names are not shown either - "Tier 2 escalations" is our
 * vocabulary, not theirs.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { StatusBadge, type TicketSummary } from '../../lib/service';
import TicketDetail from '../service/TicketDetail';
import KnowledgeList, { KnowledgeArticle } from '../service/Knowledge';
import '../../styles/command.css';
import '../../styles/service.css';

export function PortalTickets() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'active' | ''>('active');
  const [creating, setCreating] = useState(false);
  const key = `/portal/tickets?limit=50${status ? `&status=${status}` : ''}`;
  const tickets = useQuery<Paged<TicketSummary>>(key, (signal) => api.get(key, signal));

  return (
    <>
      <header className="portal-head portal-head-row">
        <div>
          <h1>Support</h1>
          <p>Ask us for help and follow every request from your organisation.</p>
        </div>
        <div className="header-controls">
          <label className="visually-hidden" htmlFor="portal-ticket-status">Show</label>
          <select id="portal-ticket-status" value={status} onChange={(e) => setStatus(e.target.value as 'active' | '')}>
            <option value="active">Open requests</option>
            <option value="">All requests</option>
          </select>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> New request
          </button>
        </div>
      </header>

      {creating ? <NewRequest onClose={() => setCreating(false)} onCreated={(id) => navigate(`/portal/tickets/${id}`)} /> : null}

      {tickets.loading && !tickets.data ? <Loading label="Loading requests" />
        : tickets.error && !tickets.data ? <ErrorState error={tickets.error} onRetry={tickets.reload} />
        : tickets.data!.items.length === 0 ? (
          <Empty title={status ? 'No open requests' : 'No requests yet'} description="When you need help, raise a request and we will reply here and by email." />
        ) : (
          <ul className="cc-panel cc-rows">
            {tickets.data!.items.map((t) => (
              <li key={t.id}>
                <Link to={`/portal/tickets/${t.id}`} className="cc-row">
                  <span className="sd-ref">{t.ref}</span>
                  <span className="cc-row-main">
                    <strong>{t.subject}</strong>
                    <span>Raised by {t.requesterName} · updated {relativeTime(t.updatedAt)}</span>
                  </span>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

export function PortalTicket() {
  return <TicketDetail apiBase="/portal" />;
}

function NewRequest({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="portal-new-request"
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setPending(true); setError(null);
          try {
            const created = await api.post<{ id: string }>('/portal/tickets', { subject, description, priority });
            onCreated(created.id);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Your request was not sent. Try again.');
            setPending(false);
          }
        }}>
        <h3 id="portal-new-request">New support request</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Subject</span>
            <input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} minLength={3} maxLength={300} required /></label>
          <label className="field sd-span-2"><span>How can we help?</span>
            <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={20000} /></label>
          <label className="field"><span>How urgent is it?</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as 'low' | 'normal' | 'high')}>
              <option value="low">Whenever convenient</option>
              <option value="normal">Normal</option>
              <option value="high">It is affecting our work</option>
            </select>
          </label>
        </div>
        <p className="field-hint">You can attach files once the request is created.</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={pending}>{pending ? 'Sending…' : 'Send request'}</button>
        </div>
      </form>
    </div>
  );
}

export function PortalKnowledge() {
  return <KnowledgeList portal />;
}

export function PortalKnowledgeArticle() {
  return <KnowledgeArticle portal />;
}
