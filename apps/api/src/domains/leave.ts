/**
 * Leave: entitlement, balances, requests and the delegation that keeps approvals moving
 * while someone is away.
 *
 * Leave rides on the approvals engine rather than reimplementing it. A leave request
 * creates an approval request and points at it, so it inherits manager routing with the
 * administrator fallback, separation of duties, escalation of overdue steps, and an
 * immutable decision history - none of which would be worth writing twice, and all of
 * which would drift if it were.
 *
 * What lives here is the part approvals cannot know: how many days a request actually
 * costs, whether the person has them, and what happens to their calendar and to their
 * own approval queue once it is granted.
 */
import { many, newId, one, reload, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import * as approvals from './approvals.js';

export type LeaveType = {
  id: string;
  company_id: string;
  key: string;
  name: string;
  paid: boolean;
  requires_approval: boolean;
  deducts_balance: boolean;
  default_annual_days: string;
  colour: string;
  active: boolean;
};

export type LeaveRequestRow = {
  id: string;
  company_id: string;
  user_id: string;
  leave_type_id: string;
  approval_request_id: string | null;
  start_date: Date;
  end_date: Date;
  half_day_start: boolean;
  half_day_end: boolean;
  working_days: string;
  reason: string | null;
  status: string;
  calendar_event_id: string | null;
  created_at: Date;
};

const DAY_MS = 86_400_000;

function toDateOnly(value: string | Date): Date {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * How many days a request actually costs.
 *
 * Weekends and company holidays are not leave, so counting calendar days would charge
 * someone for a bank holiday they never asked for. Half days are only meaningful at the
 * edges of a range, and only when that edge is itself a working day - a half day on a
 * Saturday is not a half day off.
 */
export async function workingDaysBetween(
  companyId: string,
  start: Date,
  end: Date,
  options: { halfDayStart?: boolean; halfDayEnd?: boolean } = {},
): Promise<number> {
  const holidays = await many<{ holiday_date: Date }>(
    'SELECT holiday_date FROM company_holidays WHERE company_id = $1 AND holiday_date BETWEEN $2 AND $3',
    [companyId, isoDate(start), isoDate(end)],
  );
  const holidaySet = new Set(holidays.map((h) => isoDate(toDateOnly(h.holiday_date))));

  let days = 0;
  let firstWorking: string | null = null;
  let lastWorking: string | null = null;

  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += DAY_MS) {
    const day = new Date(cursor);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const key = isoDate(day);
    if (holidaySet.has(key)) continue;
    days += 1;
    if (firstWorking === null) firstWorking = key;
    lastWorking = key;
  }

  if (days === 0) return 0;
  // Only deduct a half day when that edge is a working day, and never twice on a
  // single-day request - a half day at both ends of one day is still half a day.
  if (options.halfDayStart && firstWorking === isoDate(start)) days -= 0.5;
  if (options.halfDayEnd && lastWorking === isoDate(end) && !(days === 0.5 && firstWorking === lastWorking)) {
    if (!(options.halfDayStart && firstWorking === lastWorking)) days -= 0.5;
  }
  return Math.max(days, 0);
}

// ------------------------------------------------------------------ types and balances

export async function listTypes(actor: Actor): Promise<LeaveType[]> {
  return many<LeaveType>(
    'SELECT * FROM leave_types WHERE company_id = $1 AND active ORDER BY name',
    [actor.companyId],
  );
}

export async function createType(
  actor: Actor,
  input: {
    key: string;
    name: string;
    paid?: boolean;
    requiresApproval?: boolean;
    deductsBalance?: boolean;
    defaultAnnualDays?: number;
    colour?: string;
  },
): Promise<LeaveType> {
  await authorize({ actor, capability: 'leave.manage', resourceless: true });
  const key = input.key.trim().toLowerCase();
  const existing = await one<{ id: string }>(
    'SELECT id FROM leave_types WHERE company_id = $1 AND `key` = $2',
    [actor.companyId, key],
  );
  if (existing) throw conflict('A leave type with that key already exists');

  return transaction(async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO leave_types
         (id, company_id, \`key\`, name, paid, requires_approval, deducts_balance, default_annual_days, colour)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        actor.companyId,
        key,
        input.name.trim(),
        input.paid ?? true,
        input.requiresApproval ?? true,
        input.deductsBalance ?? true,
        input.defaultAnnualDays ?? 0,
        input.colour ?? '#6366f1',
      ],
    );
    await auditFromActor(actor, 'leave.type_create', {
      resourceType: 'leave_type',
      resourceId: id,
      metadata: { key, name: input.name },
    }, tx);
    return (await reload<LeaveType>(tx, 'leave_types', id))!;
  });
}

export type Balance = {
  leave_type_id: string;
  type_name: string;
  colour: string;
  deducts_balance: boolean;
  year: number;
  entitled_days: string;
  carried_days: string;
  taken_days: string;
  pending_days: string;
  remaining_days: number;
};

/**
 * Someone's balances for a year, creating the rows on first read.
 *
 * Created lazily rather than by a scheduled job at year end: a job that fails leaves
 * everyone unable to book leave in January, whereas this cannot be missed because
 * nothing can read a balance without it existing.
 */
export async function balancesFor(
  actor: Actor,
  userId: string,
  year = new Date().getUTCFullYear(),
): Promise<Balance[]> {
  if (userId !== actor.userId) {
    await authorize({ actor, capability: 'leave.read_all', resourceless: true });
  }

  const types = await many<LeaveType>(
    'SELECT * FROM leave_types WHERE company_id = $1 AND active',
    [actor.companyId],
  );
  for (const type of types) {
    await one(
      `INSERT IGNORE INTO leave_balances (id, company_id, user_id, leave_type_id, year, entitled_days)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), actor.companyId, userId, type.id, year, type.default_annual_days],
    );
  }

  return many<Balance>(
    `SELECT b.leave_type_id, t.name AS type_name, t.colour, t.deducts_balance, b.year,
            b.entitled_days, b.carried_days, b.taken_days, b.pending_days,
            (b.entitled_days + b.carried_days - b.taken_days - b.pending_days) AS remaining_days
       FROM leave_balances b
       JOIN leave_types t ON t.id = b.leave_type_id
      WHERE b.user_id = $1 AND b.year = $2 AND t.active
      ORDER BY t.name`,
    [userId, year],
  );
}

export async function setEntitlement(
  actor: Actor,
  input: { userId: string; leaveTypeId: string; year: number; entitledDays: number; carriedDays?: number },
): Promise<void> {
  await authorize({ actor, capability: 'leave.manage', resourceless: true });
  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO leave_balances (id, company_id, user_id, leave_type_id, year, entitled_days, carried_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON DUPLICATE KEY UPDATE
         entitled_days = VALUES(entitled_days),
         carried_days = VALUES(carried_days)`,
      [
        newId(),
        actor.companyId,
        input.userId,
        input.leaveTypeId,
        input.year,
        input.entitledDays,
        input.carriedDays ?? 0,
      ],
    );
    await auditFromActor(actor, 'leave.entitlement_set', {
      resourceType: 'user',
      resourceId: input.userId,
      metadata: { leaveTypeId: input.leaveTypeId, year: input.year, entitledDays: input.entitledDays },
    }, tx);
  });
}

// ------------------------------------------------------------------ requests

/**
 * Books leave.
 *
 * The days are reserved against the balance as `pending` in the same transaction that
 * creates the request. That reservation is what makes settlement safe to do later, off
 * the back of the approval event: whether or not the settlement has run yet, the days are
 * already counted against what the person has left, so nobody can book the same week
 * twice while the first request waits for a decision.
 */
export async function requestLeave(
  actor: Actor,
  input: {
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    halfDayStart?: boolean;
    halfDayEnd?: boolean;
    reason?: string | null;
  },
  correlationId: string,
): Promise<LeaveRequestRow> {
  await authorize({ actor, capability: 'leave.request', resourceless: true });

  const type = await one<LeaveType>(
    'SELECT * FROM leave_types WHERE id = $1 AND company_id = $2 AND active',
    [input.leaveTypeId, actor.companyId],
  );
  if (!type) throw notFound('That leave type is not available');

  const start = toDateOnly(input.startDate);
  const end = toDateOnly(input.endDate);
  if (end < start) {
    throw unprocessable('The last day cannot be before the first', [
      { field: 'endDate', message: 'Choose a date on or after the first day' },
    ]);
  }

  const workingDays = await workingDaysBetween(actor.companyId, start, end, {
    halfDayStart: input.halfDayStart,
    halfDayEnd: input.halfDayEnd,
  });
  if (workingDays <= 0) {
    throw unprocessable('That range contains no working days', [
      { field: 'startDate', message: 'Weekends and company holidays are not leave' },
    ]);
  }

  // Overlapping leave is almost always a mistake rather than an intention, and it would
  // quietly double-count the balance.
  const clash = await one<{ id: string }>(
    `SELECT id FROM leave_requests
      WHERE user_id = $1 AND status IN ('pending','approved')
        AND start_date <= $3 AND end_date >= $2`,
    [actor.userId, isoDate(start), isoDate(end)],
  );
  if (clash) throw conflict('You already have leave booked that overlaps these dates');

  const year = start.getUTCFullYear();
  if (type.deducts_balance) {
    const balances = await balancesFor(actor, actor.userId, year);
    const forType = balances.find((b) => b.leave_type_id === type.id);
    const remaining = Number(forType?.remaining_days ?? 0);
    if (remaining < workingDays) {
      throw unprocessable(
        `That is ${workingDays} day${workingDays === 1 ? '' : 's'}, and you have ${remaining} left`,
        [{ field: 'endDate', message: 'Shorten the request or speak to your manager' }],
      );
    }
  }

  const id = newId();
  const created = await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO leave_requests
         (id, company_id, user_id, leave_type_id, start_date, end_date,
          half_day_start, half_day_end, working_days, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        actor.companyId,
        actor.userId,
        type.id,
        isoDate(start),
        isoDate(end),
        input.halfDayStart ?? false,
        input.halfDayEnd ?? false,
        workingDays,
        input.reason?.trim() || null,
        type.requires_approval ? 'pending' : 'approved',
      ],
    );

    if (type.deducts_balance) {
      // Approved-on-creation types skip the queue, so their days go straight to taken.
      const column = type.requires_approval ? 'pending_days' : 'taken_days';
      await tx.query(
        `UPDATE leave_balances SET ${column} = ${column} + $3
          WHERE user_id = $1 AND leave_type_id = $2 AND year = $4`,
        [actor.userId, type.id, workingDays, year],
      );
    }

    await auditFromActor(actor, 'leave.request', {
      resourceType: 'leave_request',
      resourceId: id,
      metadata: { type: type.key, days: workingDays, from: isoDate(start), to: isoDate(end) },
    }, tx);

    return (await reload<LeaveRequestRow>(tx, 'leave_requests', id))!;
  });

  // The approval request is created after the leave row commits so that a routing
  // failure - nobody to approve it - surfaces as a failed booking the person can see and
  // retry, rather than an approval orphaned from any leave.
  if (type.requires_approval) {
    const approval = await approvals.createRequest(
      actor,
      {
        definitionKey: 'leave',
        title: `${type.name}: ${isoDate(start)} to ${isoDate(end)}`,
        data: {
          leaveRequestId: id,
          type: type.name,
          startDate: isoDate(start),
          endDate: isoDate(end),
          workingDays,
          reason: input.reason ?? null,
        },
      },
      correlationId,
    );
    await one('UPDATE leave_requests SET approval_request_id = $2 WHERE id = $1', [
      id,
      approval.id,
    ]);
    return { ...created, approval_request_id: approval.id };
  }

  return created;
}

/**
 * Moves a decided leave request out of pending.
 *
 * Driven by the approval event rather than called inline, which is safe because the days
 * were reserved at booking time: until this runs they are still counted against the
 * person's balance, so a delayed settlement can under-report what has been taken but can
 * never let someone over-book.
 */
export async function settleDecision(
  leaveRequestId: string,
  decision: 'approved' | 'rejected' | 'cancelled',
): Promise<void> {
  await transaction(async (tx) => {
    const request = await one<LeaveRequestRow>(
      "SELECT * FROM leave_requests WHERE id = $1 AND status = 'pending'",
      [leaveRequestId],
    );
    if (!request) return;

    const type = await one<LeaveType>('SELECT * FROM leave_types WHERE id = $1', [
      request.leave_type_id,
    ]);
    const year = new Date(request.start_date).getUTCFullYear();

    if (type?.deducts_balance) {
      if (decision === 'approved') {
        await tx.query(
          `UPDATE leave_balances
              SET pending_days = GREATEST(pending_days - $3, 0), taken_days = taken_days + $3
            WHERE user_id = $1 AND leave_type_id = $2 AND year = $4`,
          [request.user_id, request.leave_type_id, request.working_days, year],
        );
      } else {
        await tx.query(
          `UPDATE leave_balances SET pending_days = GREATEST(pending_days - $3, 0)
            WHERE user_id = $1 AND leave_type_id = $2 AND year = $4`,
          [request.user_id, request.leave_type_id, request.working_days, year],
        );
      }
    }

    await tx.query('UPDATE leave_requests SET status = $2, updated_at = NOW(3) WHERE id = $1', [
      leaveRequestId,
      decision,
    ]);
  });
}

export async function listLeave(
  actor: Actor,
  filters: { userId?: string; from?: string; to?: string; status?: string } = {},
): Promise<unknown[]> {
  const mine = !filters.userId || filters.userId === actor.userId;
  if (!mine) await authorize({ actor, capability: 'leave.read_all', resourceless: true });

  return many(
    `SELECT r.*, t.name AS type_name, t.colour, u.display_name AS user_name
       FROM leave_requests r
       JOIN leave_types t ON t.id = r.leave_type_id
       JOIN users u ON u.id = r.user_id
      WHERE r.company_id = $1
        AND ($2 IS NULL OR r.user_id = $2)
        AND ($3 IS NULL OR r.end_date >= $3)
        AND ($4 IS NULL OR r.start_date <= $4)
        AND ($5 IS NULL OR r.status = $5)
      ORDER BY r.start_date DESC
      LIMIT 300`,
    [
      actor.companyId,
      filters.userId ?? (mine ? actor.userId : null),
      filters.from ?? null,
      filters.to ?? null,
      filters.status ?? null,
    ],
  );
}

/** Who is away over a window - the question a manager asks before planning anything. */
export async function whoIsAway(actor: Actor, from: string, to: string): Promise<unknown[]> {
  await authorize({ actor, capability: 'leave.read_all', resourceless: true });
  return many(
    `SELECT r.user_id, u.display_name, u.avatar_color, t.name AS type_name, t.colour,
            r.start_date, r.end_date, r.half_day_start, r.half_day_end, r.status
       FROM leave_requests r
       JOIN users u ON u.id = r.user_id
       JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.company_id = $1
        AND r.status IN ('approved','pending')
        AND r.end_date >= $2 AND r.start_date <= $3
      ORDER BY r.start_date`,
    [actor.companyId, from, to],
  );
}

export async function cancelLeave(actor: Actor, id: string, reason: string): Promise<void> {
  const request = await one<LeaveRequestRow>(
    'SELECT * FROM leave_requests WHERE id = $1 AND company_id = $2',
    [id, actor.companyId],
  );
  if (!request) throw notFound('Leave request not found');
  if (request.user_id !== actor.userId) {
    await authorize({ actor, capability: 'leave.manage', resourceless: true });
  }
  if (request.status === 'cancelled') throw conflict('This request is already cancelled');
  if (request.status === 'rejected') throw conflict('A rejected request cannot be cancelled');

  const year = new Date(request.start_date).getUTCFullYear();
  await transaction(async (tx) => {
    const type = await one<LeaveType>('SELECT * FROM leave_types WHERE id = $1', [
      request.leave_type_id,
    ]);
    if (type?.deducts_balance) {
      // Release from whichever bucket the days are sitting in.
      const column = request.status === 'approved' ? 'taken_days' : 'pending_days';
      await tx.query(
        `UPDATE leave_balances SET ${column} = GREATEST(${column} - $3, 0)
          WHERE user_id = $1 AND leave_type_id = $2 AND year = $4`,
        [request.user_id, request.leave_type_id, request.working_days, year],
      );
    }
    await tx.query(
      "UPDATE leave_requests SET status = 'cancelled', cancelled_reason = $2, updated_at = NOW(3) WHERE id = $1",
      [id, reason.trim()],
    );
    // A delegation created to cover this leave has nothing left to cover.
    await tx.query(
      'UPDATE approval_delegations SET revoked_at = NOW(3) WHERE leave_request_id = $1 AND revoked_at IS NULL',
      [id],
    );
    await auditFromActor(actor, 'leave.cancel', {
      resourceType: 'leave_request',
      resourceId: id,
      metadata: { reason: reason.trim(), previousStatus: request.status },
    }, tx);
  });
}

// ------------------------------------------------------------------ delegation

export type DelegationRow = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  starts_at: Date;
  ends_at: Date;
  reason: string | null;
  leave_request_id: string | null;
  revoked_at: Date | null;
};

/**
 * Hands your approvals to someone else for a window.
 *
 * Unroutable approval requests refuse outright rather than stranding, which is the right
 * behaviour but means an approver going away blocks everything routed to them. This is
 * the release valve, and it is a window rather than a switch so it can be arranged for a
 * holiday months ahead and expires without anyone remembering to turn it off.
 */
export async function createDelegation(
  actor: Actor,
  input: {
    fromUserId?: string;
    toUserId: string;
    startsAt: string;
    endsAt: string;
    reason?: string | null;
    leaveRequestId?: string | null;
  },
): Promise<DelegationRow> {
  const fromUserId = input.fromUserId ?? actor.userId;
  // Delegating your own approvals needs no privilege; arranging cover for someone else
  // is an administrative act.
  if (fromUserId !== actor.userId) {
    await authorize({ actor, capability: 'delegation.manage', resourceless: true });
  }
  if (fromUserId === input.toUserId) {
    throw unprocessable('Choose someone else to cover you', [
      { field: 'toUserId', message: 'You cannot delegate to yourself' },
    ]);
  }

  const delegate = await one<{ id: string; status: string }>(
    'SELECT id, status FROM users WHERE id = $1 AND company_id = $2',
    [input.toUserId, actor.companyId],
  );
  if (!delegate) throw notFound('That person was not found');
  if (delegate.status !== 'active') {
    throw unprocessable('Cover must be someone who can actually sign in', [
      { field: 'toUserId', message: 'Choose an active colleague' },
    ]);
  }

  const starts = new Date(input.startsAt);
  const ends = new Date(input.endsAt);
  if (ends <= starts) {
    throw unprocessable('The delegation must end after it starts', [
      { field: 'endsAt', message: 'Choose a later end' },
    ]);
  }

  // Two open delegations over the same window would make it non-deterministic which
  // colleague a decision reaches.
  const overlapping = await one<{ id: string }>(
    `SELECT id FROM approval_delegations
      WHERE company_id = $1 AND from_user_id = $2 AND revoked_at IS NULL
        AND starts_at < $4 AND ends_at > $3`,
    [actor.companyId, fromUserId, starts, ends],
  );
  if (overlapping) throw conflict('You already have cover arranged over part of that period');

  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO approval_delegations
         (id, company_id, from_user_id, to_user_id, starts_at, ends_at, reason, leave_request_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        actor.companyId,
        fromUserId,
        input.toUserId,
        starts,
        ends,
        input.reason?.trim() || null,
        input.leaveRequestId ?? null,
        actor.userId,
      ],
    );
    await auditFromActor(actor, 'delegation.create', {
      resourceType: 'user',
      resourceId: fromUserId,
      metadata: { toUserId: input.toUserId, startsAt: input.startsAt, endsAt: input.endsAt },
    }, tx);
    return (await reload<DelegationRow>(tx, 'approval_delegations', id))!;
  });
}

export async function listDelegations(actor: Actor, userId?: string): Promise<unknown[]> {
  const target = userId ?? actor.userId;
  if (target !== actor.userId) {
    await authorize({ actor, capability: 'delegation.manage', resourceless: true });
  }
  return many(
    `SELECT d.*, f.display_name AS from_name, t.display_name AS to_name
       FROM approval_delegations d
       JOIN users f ON f.id = d.from_user_id
       JOIN users t ON t.id = d.to_user_id
      WHERE d.company_id = $1 AND (d.from_user_id = $2 OR d.to_user_id = $2)
      ORDER BY d.starts_at DESC
      LIMIT 100`,
    [actor.companyId, target],
  );
}

export async function revokeDelegation(actor: Actor, id: string): Promise<void> {
  const delegation = await one<DelegationRow>(
    'SELECT * FROM approval_delegations WHERE id = $1 AND company_id = $2',
    [id, actor.companyId],
  );
  if (!delegation) throw notFound('Delegation not found');
  if (delegation.from_user_id !== actor.userId) {
    await authorize({ actor, capability: 'delegation.manage', resourceless: true });
  }
  if (delegation.revoked_at) throw conflict('This delegation has already been withdrawn');

  await transaction(async (tx) => {
    await tx.query('UPDATE approval_delegations SET revoked_at = NOW(3) WHERE id = $1', [id]);
    await auditFromActor(actor, 'delegation.revoke', {
      resourceType: 'user',
      resourceId: delegation.from_user_id,
      metadata: { delegationId: id },
    }, tx);
  });
}

/**
 * Decisions already in flight when cover was arranged.
 *
 * Delegation is applied when a route is resolved, so a request raised before the window
 * opened is still sitting with the person who is now away. Reassigning those is the
 * difference between cover that works and cover that only applies to new work.
 */
export async function reassignActiveSteps(
  actor: Actor,
  fromUserId: string,
  toUserId: string,
): Promise<number> {
  if (fromUserId !== actor.userId) {
    await authorize({ actor, capability: 'delegation.manage', resourceless: true });
  }
  const result = await transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE approval_steps s
         JOIN approval_requests r ON r.id = s.request_id
          SET s.approver_id = $2
        WHERE s.approver_id = $1 AND s.state = 'active' AND r.company_id = $3
          -- Never hand someone their own request to approve: separation of duties is
          -- enforced at decision time, and routing it there would only dead-end.
          AND r.requester_id <> $2`,
      [fromUserId, toUserId, actor.companyId],
    );
    await auditFromActor(actor, 'delegation.reassign', {
      resourceType: 'user',
      resourceId: fromUserId,
      metadata: { toUserId, moved: updated.rowCount ?? 0 },
    }, tx);
    return updated.rowCount ?? 0;
  });
  return result;
}

// ------------------------------------------------------------------ holidays

export type Holiday = { id: string; holiday_date: Date; name: string };

export async function listHolidays(actor: Actor, year?: number): Promise<Holiday[]> {
  return many<Holiday>(
    `SELECT id, holiday_date, name FROM company_holidays
      WHERE company_id = $1 AND ($2 IS NULL OR YEAR(holiday_date) = $2)
      ORDER BY holiday_date`,
    [actor.companyId, year ?? null],
  );
}

/**
 * Adds a public holiday.
 *
 * These are company data rather than a library because they differ by country and by
 * year, and because a wrong list does not fail loudly - it silently charges everyone a
 * day of their entitlement for a day the office was shut.
 */
export async function addHoliday(
  actor: Actor,
  input: { date: string; name: string },
): Promise<Holiday> {
  await authorize({ actor, capability: 'leave.manage', resourceless: true });
  const existing = await one<{ id: string }>(
    'SELECT id FROM company_holidays WHERE company_id = $1 AND holiday_date = $2',
    [actor.companyId, input.date],
  );
  if (existing) throw conflict('That date is already a holiday');

  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      'INSERT INTO company_holidays (id, company_id, holiday_date, name) VALUES ($1,$2,$3,$4)',
      [id, actor.companyId, input.date, input.name.trim()],
    );
    await auditFromActor(actor, 'leave.holiday_add', {
      resourceType: 'company',
      resourceId: actor.companyId,
      metadata: { date: input.date, name: input.name },
    }, tx);
    return (await reload<Holiday>(tx, 'company_holidays', id))!;
  });
}

export async function removeHoliday(actor: Actor, id: string): Promise<void> {
  await authorize({ actor, capability: 'leave.manage', resourceless: true });
  await transaction(async (tx) => {
    const removed = await tx.query(
      'DELETE FROM company_holidays WHERE id = $1 AND company_id = $2',
      [id, actor.companyId],
    );
    if (removed.rowCount === 0) throw notFound('Holiday not found');
    await auditFromActor(actor, 'leave.holiday_remove', {
      resourceType: 'company',
      resourceId: actor.companyId,
      metadata: { holidayId: id },
    }, tx);
  });
}

/** Everyone's balances for a year, for the administrator setting entitlements. */
export async function balanceOverview(actor: Actor, year: number): Promise<unknown[]> {
  await authorize({ actor, capability: 'leave.manage', resourceless: true });
  return many(
    `SELECT u.id AS user_id, u.display_name, u.avatar_color,
            t.id AS leave_type_id, t.name AS type_name, t.colour,
            COALESCE(b.entitled_days, 0) AS entitled_days,
            COALESCE(b.carried_days, 0) AS carried_days,
            COALESCE(b.taken_days, 0) AS taken_days,
            COALESCE(b.pending_days, 0) AS pending_days
       FROM users u
       CROSS JOIN leave_types t
       LEFT JOIN leave_balances b
              ON b.user_id = u.id AND b.leave_type_id = t.id AND b.year = $2
      WHERE u.company_id = $1 AND u.status = 'active' AND u.access_level <> 'guest'
        AND t.company_id = $1 AND t.active AND t.deducts_balance
      ORDER BY u.display_name, t.name`,
    [actor.companyId, year],
  );
}
