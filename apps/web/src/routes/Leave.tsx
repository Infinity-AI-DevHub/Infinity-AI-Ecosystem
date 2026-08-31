/**
 * Leave: what you have left, what you have booked, and who else is away.
 *
 * The balance is the first thing on the page because it is the question people actually
 * arrive with, and it separates booked-but-not-yet-approved from actually taken - which
 * is the difference between "I have ten days" and "I have ten days unless the request I
 * made on Tuesday comes back".
 */
import { useMemo, useState } from 'react';
import { CalendarPlus, Users } from 'lucide-react';
import { api, idempotencyKey } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, FormError } from '../components/States';
import { formatDate, initials, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import { LeaveTypeAdmin } from '../components/LeaveTypeAdmin';

type LeaveType = {
  id: string;
  key: string;
  name: string;
  colour: string;
  deducts_balance: boolean;
  requires_approval: boolean;
};

type Balance = {
  leave_type_id: string;
  type_name: string;
  colour: string;
  deducts_balance: boolean;
  entitled_days: string;
  carried_days: string;
  taken_days: string;
  pending_days: string;
  remaining_days: string;
};

type LeaveRequest = {
  id: string;
  type_name: string;
  colour: string;
  user_name: string;
  start_date: string;
  end_date: string;
  working_days: string;
  status: string;
  reason: string | null;
};

type Away = {
  user_id: string;
  display_name: string;
  avatar_color: string;
  type_name: string;
  colour: string;
  start_date: string;
  end_date: string;
  status: string;
};

const days = (value: string | number) => {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

export default function Leave() {
  const { can } = useSession();
  const [booking, setBooking] = useState(false);

  const balances = useQuery<{ items: Balance[] }>('/leave/balances', (signal) =>
    api.get('/leave/balances', signal),
  );
  const requests = useQuery<{ items: LeaveRequest[] }>('/leave/requests', (signal) =>
    api.get('/leave/requests', signal),
  );

  // A fortnight either side is the window a manager plans against.
  const window = useMemo(() => {
    const from = new Date();
    const to = new Date(Date.now() + 28 * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, []);
  const awayKey = can('leave.read_all')
    ? `/leave/away?from=${window.from}&to=${window.to}`
    : null;
  const away = useQuery<{ items: Away[] }>(awayKey, (signal) => api.get(awayKey!, signal));

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Leave</h2>
          <p>Your entitlement, your bookings, and who is away.</p>
        </div>
        {can('leave.request') ? (
          <button type="button" className="primary-button" onClick={() => setBooking(true)}>
            <CalendarPlus size={15} aria-hidden="true" /> Book leave
          </button>
        ) : null}
      </header>

      {can('leave.manage') ? <LeaveTypeAdmin /> : null}

      <AsyncSection query={balances}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty
              title="No leave types configured"
              description="An administrator sets these up before anyone can book."
            />
          ) : (
            <div className="metric-row">
              {data.items
                .filter((balance) => balance.deducts_balance)
                .map((balance) => (
                  <div className="metric-card balance-card" key={balance.leave_type_id}>
                    <span className="balance-swatch" style={{ background: balance.colour }} aria-hidden="true" />
                    <strong>{days(balance.remaining_days)}</strong>
                    <span>{balance.type_name} left</span>
                    <p className="balance-breakdown">
                      {days(balance.taken_days)} taken
                      {Number(balance.pending_days) > 0
                        ? ` · ${days(balance.pending_days)} awaiting approval`
                        : ''}
                      {' · '}
                      {days(Number(balance.entitled_days) + Number(balance.carried_days))} total
                    </p>
                  </div>
                ))}
            </div>
          )
        }
      </AsyncSection>

      <div className={awayKey ? 'split-layout' : ''}>
        <section className="panel" aria-label="Your leave">
          <h3 className="panel-title">Your leave</h3>
          <AsyncSection query={requests}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty title="Nothing booked" description="Leave you book will appear here." />
              ) : (
                <ul className="leave-list">
                  {data.items.map((request) => (
                    <LeaveRow key={request.id} request={request} />
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>

        {awayKey ? (
          <section className="panel" aria-label="Who is away">
            <div className="panel-header">
              <div>
                <Users size={16} aria-hidden="true" />
                <h3>Away in the next four weeks</h3>
              </div>
            </div>
            <AsyncSection query={away}>
              {(data) =>
                data.items.length === 0 ? (
                  <p className="panel-empty">Nobody is booked off in this period.</p>
                ) : (
                  <ul className="away-list">
                    {data.items.map((entry, index) => (
                      <li key={`${entry.user_id}-${entry.start_date}-${index}`}>
                        <span className="avatar" style={{ background: entry.avatar_color }} aria-hidden="true">
                          {initials(entry.display_name)}
                        </span>
                        <div>
                          <strong>{entry.display_name}</strong>
                          <span>
                            {formatDate(entry.start_date)}
                            {entry.start_date !== entry.end_date ? ` – ${formatDate(entry.end_date)}` : ''}
                          </span>
                        </div>
                        <span
                          className="leave-chip"
                          style={{ background: `${entry.colour}1a`, color: entry.colour }}
                        >
                          {entry.type_name}
                        </span>
                        {entry.status === 'pending' ? (
                          <span className="status-tag status-pending">Pending</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )
              }
            </AsyncSection>
          </section>
        ) : null}
      </div>

      {booking ? <BookDialog onClose={() => setBooking(false)} /> : null}
    </div>
  );
}

function LeaveRow({ request }: { request: LeaveRequest }) {
  const cancel = useMutation(
    async () => api.post(`/leave/requests/${request.id}/cancel`, { reason: 'No longer needed' }),
    { invalidates: ['/leave'] },
  );

  const cancellable = request.status === 'pending' || request.status === 'approved';

  return (
    <li className="leave-row">
      <span className="leave-bar" style={{ background: request.colour }} aria-hidden="true" />
      <div className="leave-body">
        <strong>
          {formatDate(request.start_date)}
          {request.start_date !== request.end_date ? ` – ${formatDate(request.end_date)}` : ''}
        </strong>
        <span>
          {request.type_name} · {days(request.working_days)} day
          {Number(request.working_days) === 1 ? '' : 's'}
          {request.reason ? ` · ${request.reason}` : ''}
        </span>
      </div>
      <span className={`status-tag status-${request.status}`}>{titleCase(request.status)}</span>
      {cancellable ? (
        <button
          type="button"
          className="ghost-button"
          disabled={cancel.pending}
          onClick={() => void cancel.mutate()}
        >
          Cancel
        </button>
      ) : null}
      <FormError error={cancel.error} />
    </li>
  );
}

function BookDialog({ onClose }: { onClose: () => void }) {
  const types = useQuery<{ items: LeaveType[] }>('/leave/types', (signal) =>
    api.get('/leave/types', signal),
  );
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [halfDayStart, setHalfDayStart] = useState(false);
  const [halfDayEnd, setHalfDayEnd] = useState(false);
  const [reason, setReason] = useState('');
  const key = useMemo(() => idempotencyKey(), []);

  const book = useMutation(
    async () =>
      api.post(
        '/leave/requests',
        {
          leaveTypeId,
          startDate,
          endDate: endDate || startDate,
          halfDayStart,
          halfDayEnd,
          reason: reason || null,
        },
        { idempotencyKey: key },
      ),
    {
      invalidates: ['/leave'],
      onSuccess: () => {
        invalidate('/approvals');
        onClose();
      },
    },
  );

  const selected = types.data?.items.find((t) => t.id === leaveTypeId);

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-leave-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="book-leave-title">Book leave</h3>
        <p className="field-hint">
          Weekends and company holidays are not counted, so a week off over a bank holiday
          costs you four days rather than five.
        </p>

        <FormError error={book.error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void book.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="leave-type">Type</label>
            <select
              id="leave-type"
              value={leaveTypeId}
              onChange={(event) => setLeaveTypeId(event.target.value)}
              required
            >
              <option value="">Choose…</option>
              {(types.data?.items ?? []).map((type) => (
                <option key={type.id} value={type.id}>{type.name}</option>
              ))}
            </select>
            {selected && !selected.requires_approval ? (
              <p className="field-hint">This type does not need approval — it is recorded straight away.</p>
            ) : null}
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="leave-start">First day</label>
              <input
                id="leave-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                required
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={halfDayStart}
                  onChange={(event) => setHalfDayStart(event.target.checked)}
                />
                Half day
              </label>
            </div>
            <div className="field">
              <label htmlFor="leave-end">Last day</label>
              <input
                id="leave-end"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={halfDayEnd}
                  onChange={(event) => setHalfDayEnd(event.target.checked)}
                />
                Half day
              </label>
            </div>
          </div>

          <div className="field">
            <label htmlFor="leave-reason">Note (optional)</label>
            <input
              id="leave-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Anything your approver should know"
            />
          </div>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={book.pending || !leaveTypeId || !startDate}>
              {book.pending ? 'Booking…' : 'Book leave'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
