/**
 * Approvals (blueprint 04).
 *
 * Decisions carry an idempotency key so a retry after a timeout cannot record twice,
 * and the immutable decision history is shown alongside the current state.
 */
import { useMemo, useState } from 'react';
import { FilePreview, type PreviewTarget } from '../components/FilePreview';
import { EvidenceUpload, EvidenceList, type AttachedFile } from '../components/EvidenceUpload';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, FilePlus2, RotateCcw, X } from 'lucide-react';
import { api, idempotencyKey } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading, FormError } from '../components/States';
import { formatCurrency, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Request = {
  id: string;
  reference: string;
  title: string;
  amount: number | null;
  currency: string;
  status: string;
  current_step: number;
  requester_name: string;
  definition_name: string;
  awaiting_me: boolean;
  created_at: string;
};

type RequestDetail = Request & {
  data: Record<string, unknown>;
  steps: { step_number: number; state: string; approver_id: string; approver_name: string }[];
  decisions: {
    step_number: number;
    decision: string;
    comment: string | null;
    created_at: string;
    approver_name: string;
  }[];
  evidence?: {
    id: string; file_id: string; name: string; mime_type: string | null; size_bytes: number;
  }[];
};

type Definition = { id: string; key: string; name: string };

type Scope = 'pending_me' | 'mine' | 'all';

export default function Approvals() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const [scope, setScope] = useState<Scope>('pending_me');
  const [raising, setRaising] = useState(false);

  const listKey = `/approvals?scope=${scope}&limit=50`;
  const requests = useQuery<{ items: Request[] }>(listKey, (signal) => api.get(listKey, signal));

  const detailKey = requestId ? `/approvals/${requestId}` : null;
  const detail = useQuery<RequestDetail>(detailKey, (signal) =>
    api.get(`/approvals/${requestId}`, signal),
  );

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Approvals</h2>
          <p>Requests routed to you, and the ones you raised.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setRaising(true)}>
          <FilePlus2 size={15} aria-hidden="true" /> Raise a request
        </button>
      </header>

      <div className="tab-row" role="tablist" aria-label="Approval filters">
        {(
          [
            ['pending_me', 'Awaiting me'],
            ['mine', 'Raised by me'],
            ...(can('approval.report') ? ([['all', 'All requests']] as const) : []),
          ] as [Scope, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={scope === value}
            className={`tab ${scope === value ? 'tab-active' : ''}`}
            onClick={() => {
              setScope(value);
              navigate('/approvals');
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="split-layout">
        <section className="panel" aria-label="Requests">
          <AsyncSection query={requests}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty
                  title={scope === 'pending_me' ? 'Nothing awaiting you' : 'No requests'}
                  description={
                    scope === 'pending_me'
                      ? 'Requests needing your decision will appear here.'
                      : 'Raise a request to get started.'
                  }
                />
              ) : (
                <ul className="request-list">
                  {data.items.map((request) => (
                    <li key={request.id}>
                      <button
                        type="button"
                        className={`request-row ${request.id === requestId ? 'request-active' : ''}`}
                        onClick={() => navigate(`/approvals/${request.id}`)}
                      >
                        <span className="request-reference">{request.reference}</span>
                        <span className="request-body">
                          <strong>{request.title}</strong>
                          <span>
                            {request.definition_name} · {request.requester_name}
                            {request.amount !== null
                              ? ` · ${formatCurrency(request.amount, request.currency)}`
                              : ''}
                          </span>
                        </span>
                        <span className={`status-tag status-${request.status}`}>
                          {titleCase(request.status)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>

        <section className="panel" aria-label="Request detail">
          {!requestId ? (
            <Empty title="Select a request" description="Choose a request to review it." />
          ) : detail.loading ? (
            <Loading label="Loading request" />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={detail.reload} />
          ) : detail.data ? (
            <RequestDetailView detail={detail} />
          ) : null}
        </section>
      </div>

      {raising ? (
        <RaiseDialog
          onClose={() => setRaising(false)}
          onCreated={(id) => {
            setRaising(false);
            invalidate('/approvals');
            navigate(`/approvals/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function RequestDetailView({ detail }: { detail: ReturnType<typeof useQuery<RequestDetail>> }) {
  const request = detail.data!;
  const { session } = useSession();
  const [comment, setComment] = useState('');
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null);
  // One key per mounted request, so a retried click is recognised as the same decision.
  const key = useMemo(() => idempotencyKey(), [request.id]);

  const decide = useMutation(
    async (decision: 'approved' | 'rejected' | 'returned') =>
      api.post(
        `/approvals/${request.id}/decisions`,
        { decision, comment: comment || undefined },
        { idempotencyKey: `${key}-${decision}` },
      ),
    {
      invalidates: ['/approvals', '/me/dashboard'],
      onSuccess: () => {
        setComment('');
        detail.reload();
      },
    },
  );

  /**
   * The active step alone is not enough: every step is active for somebody, so testing
   * only the step state offered Approve and Reject to anyone who could read a request.
   * The server refuses those, but presenting an action that can only ever fail is its
   * own defect - and on an approval screen it invites a reviewer to believe they hold a
   * decision that is in fact someone else's.
   */
  const awaitingMe = request.steps.some(
    (step) =>
      step.step_number === request.current_step &&
      step.state === 'active' &&
      step.approver_id === session?.user?.id,
  );

  return (
    <article className="request-detail">
      <h3>{request.title}</h3>
      <p className="task-meta">
        {request.reference} · {request.definition_name} · raised by {request.requester_name} ·{' '}
        <time dateTime={request.created_at}>{relativeTime(request.created_at)}</time>
      </p>

      {request.amount !== null ? (
        <p className="request-amount">{formatCurrency(request.amount, request.currency)}</p>
      ) : null}

      <section>
        <h4>
          Supporting documents
          {(request.evidence?.length ?? 0) > 0 ? (
            <span className="count-badge">{request.evidence!.length}</span>
          ) : null}
        </h4>
        <EvidenceList
          items={request.evidence ?? []}
          onOpen={setPreviewing}
          emptyText="Nothing was attached to this request."
        />
      </section>

      <section>
        <h4>Route</h4>
        <ol className="route-list">
          {request.steps.map((step) => (
            <li key={`${step.step_number}-${step.approver_id}`} className={`route-${step.state}`}>
              <span>Step {step.step_number}</span>
              <strong>{step.approver_name}</strong>
              <span className="status-tag">{titleCase(step.state)}</span>
            </li>
          ))}
        </ol>
      </section>

      {request.decisions.length > 0 ? (
        <section>
          <h4>Decision history</h4>
          <ul className="decision-list">
            {request.decisions.map((decision, index) => (
              <li key={`${decision.created_at}-${index}`}>
                <strong>{decision.approver_name}</strong> {decision.decision} at step{' '}
                {decision.step_number}
                <time dateTime={decision.created_at}>{relativeTime(decision.created_at)}</time>
                {decision.comment ? <p>{decision.comment}</p> : null}
              </li>
            ))}
          </ul>
          <p className="field-hint">This history is immutable and cannot be edited.</p>
        </section>
      ) : null}

      {previewing ? (
        <FilePreview target={previewing} onClose={() => setPreviewing(null)} />
      ) : null}

      {request.status === 'pending' && awaitingMe ? (
        <section className="decision-block">
          <h4>Your decision</h4>
          <FormError error={decide.error} />
          <label className="visually-hidden" htmlFor="decision-comment">Comment</label>
          <textarea
            id="decision-comment"
            rows={3}
            placeholder="Add a comment (optional)"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="decision-buttons">
            <button
              type="button"
              className="primary-button"
              disabled={decide.pending}
              onClick={() => void decide.mutate('approved')}
            >
              <Check size={15} aria-hidden="true" /> Approve
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={decide.pending}
              onClick={() => void decide.mutate('returned')}
            >
              <RotateCcw size={15} aria-hidden="true" /> Return for changes
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={decide.pending}
              onClick={() => void decide.mutate('rejected')}
            >
              <X size={15} aria-hidden="true" /> Reject
            </button>
          </div>
        </section>
      ) : request.status === 'pending' ? (
        <p className="panel-empty">This request is waiting on someone else.</p>
      ) : (
        <p className="panel-empty">
          This request is {titleCase(request.status).toLowerCase()} and closed.
        </p>
      )}
    </article>
  );
}

function RaiseDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [definitionKey, setDefinitionKey] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState<AttachedFile[]>([]);
  const key = useMemo(() => idempotencyKey(), []);

  const definitions = useQuery<{ items: Definition[] }>('/approvals/definitions', (signal) =>
    api.get('/approvals/definitions', signal),
  );

  const create = useMutation(
    async () =>
      api.post<{ id: string }>(
        '/approvals',
        {
          definitionKey: definitionKey || definitions.data?.items[0]?.key,
          title,
          amount: amount ? Number(amount) : null,
          evidenceFileIds: evidence.map((file) => file.id),
        },
        { idempotencyKey: key },
      ),
    { invalidates: ['/approvals'], onSuccess: (request) => onCreated(request.id) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="raise-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="raise-title">Raise a request</h3>
        <FormError error={create.error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="request-type">Request type</label>
            <select
              id="request-type"
              value={definitionKey}
              onChange={(event) => setDefinitionKey(event.target.value)}
              required
            >
              <option value="">Choose a type</option>
              {(definitions.data?.items ?? []).map((definition) => (
                <option key={definition.id} value={definition.key}>{definition.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="request-title">Summary</label>
            <input
              id="request-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="request-amount">Amount (if applicable)</label>
            <input
              id="request-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <p className="field-hint">
              The approval route is chosen by amount and department, so this can change who
              needs to approve.
            </p>
          </div>

          <EvidenceUpload
            files={evidence}
            onChange={setEvidence}
            label="Supporting documents"
            hint="A receipt, a quote, a contract — whatever the approver needs to decide."
          />

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
