/**
 * Reporting across the whole workspace.
 *
 * `report.read` has been granted to roles since the first migration and checked nowhere,
 * which is the kind of dead grant that gets waved through an access review. This is what
 * it now means.
 *
 * The reports here answer questions someone actually asks out loud rather than counting
 * everything countable: how many of us are there, who is away, what is stuck waiting for
 * a decision, what have we spent, and - the one that costs real money - which approved
 * expenses has nobody paid and which laptops are still out with people who have left.
 */
import { many, one } from '../core/db.js';
import { authorize, type Actor } from '../core/authz.js';

export type Overview = Record<string, unknown>;

/** Headcount now, plus joiners and leavers over the last twelve months. */
export async function headcount(actor: Actor): Promise<Overview> {
  await authorize({ actor, capability: 'report.read', resourceless: true });

  const byStatus = await many(
    `SELECT status, COUNT(*) AS count FROM users
      WHERE company_id = $1 AND access_level <> 'guest'
      GROUP BY status`,
    [actor.companyId],
  );
  const byDepartment = await many(
    `SELECT COALESCE(d.name, 'Unassigned') AS department, COUNT(*) AS count
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.company_id = $1 AND u.status = 'active' AND u.access_level <> 'guest'
      GROUP BY d.name
      ORDER BY count DESC`,
    [actor.companyId],
  );
  const movement = await many(
    `SELECT DATE_FORMAT(m.month, '%Y-%m') AS month,
            SUM(m.joined) AS joined, SUM(m.left_count) AS left_count
       FROM (
         SELECT DATE_FORMAT(activated_at, '%Y-%m-01') AS month, 1 AS joined, 0 AS left_count
           FROM users
          WHERE company_id = $1 AND activated_at IS NOT NULL
            AND activated_at > DATE_SUB(NOW(3), INTERVAL 12 MONTH)
         UNION ALL
         SELECT DATE_FORMAT(offboarded_at, '%Y-%m-01') AS month, 0, 1
           FROM users
          WHERE company_id = $1 AND offboarded_at IS NOT NULL
            AND offboarded_at > DATE_SUB(NOW(3), INTERVAL 12 MONTH)
       ) m
      GROUP BY m.month
      ORDER BY m.month`,
    [actor.companyId],
  );
  // A guest count belongs here too: external people with live access are part of the
  // answer to "who can reach our things", even though they are not headcount.
  const guests = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM users
      WHERE company_id = $1 AND access_level = 'guest' AND status = 'active'`,
    [actor.companyId],
  );

  return { byStatus, byDepartment, movement, activeGuests: Number(guests?.count ?? 0) };
}

/** Approval throughput, and what is currently stuck. */
export async function approvals(actor: Actor): Promise<Overview> {
  await authorize({ actor, capability: 'report.read', resourceless: true });

  const byStatus = await many(
    `SELECT status, COUNT(*) AS count FROM approval_requests
      WHERE company_id = $1 GROUP BY status`,
    [actor.companyId],
  );
  const speed = await one<{ median_hours: number; decided: number }>(
    `SELECT AVG(TIMESTAMPDIFF(HOUR, r.created_at, d.created_at)) AS median_hours,
            COUNT(*) AS decided
       FROM approval_requests r
       JOIN approval_decisions d ON d.request_id = r.id
      WHERE r.company_id = $1 AND r.created_at > DATE_SUB(NOW(3), INTERVAL 90 DAY)`,
    [actor.companyId],
  );
  // Overdue is the number that matters: a queue with an average of two days can still be
  // hiding one request that has waited three weeks.
  const overdue = await many(
    `SELECT r.reference, r.title, r.due_at, u.display_name AS waiting_on,
            TIMESTAMPDIFF(DAY, r.due_at, NOW(3)) AS days_overdue
       FROM approval_requests r
       JOIN approval_steps s ON s.request_id = r.id AND s.state = 'active'
       JOIN users u ON u.id = s.approver_id
      WHERE r.company_id = $1 AND r.status = 'pending' AND r.due_at < NOW(3)
      ORDER BY r.due_at
      LIMIT 50`,
    [actor.companyId],
  );

  return {
    byStatus,
    averageHoursToDecision: speed?.median_hours === null ? null : Number(speed?.median_hours ?? 0),
    decidedLast90Days: Number(speed?.decided ?? 0),
    overdue,
  };
}

/** Spend, and the money that has been approved but never actually paid. */
export async function spend(actor: Actor): Promise<Overview> {
  await authorize({ actor, capability: 'report.read', resourceless: true });

  const byMonth = await many(
    `SELECT DATE_FORMAT(c.created_at, '%Y-%m') AS month, c.currency,
            SUM(c.total_amount) AS total, COUNT(*) AS claims
       FROM expense_claims c
      WHERE c.company_id = $1 AND c.status IN ('approved','reimbursed')
        AND c.created_at > DATE_SUB(NOW(3), INTERVAL 12 MONTH)
      GROUP BY month, c.currency
      ORDER BY month`,
    [actor.companyId],
  );
  const byCategory = await many(
    `SELECT COALESCE(cat.name, 'Uncategorised') AS category,
            SUM(i.amount + i.tax_amount) AS total
       FROM expense_items i
       JOIN expense_claims c ON c.id = i.claim_id
       LEFT JOIN expense_categories cat ON cat.id = i.category_id
      WHERE c.company_id = $1 AND c.status IN ('approved','reimbursed')
      GROUP BY cat.name
      ORDER BY total DESC`,
    [actor.companyId],
  );
  /**
   * Approved but unpaid, oldest first.
   *
   * This is the report the whole expense module exists to make possible. Approval and
   * reimbursement are separate states precisely so this question has an answer, and it
   * is the one people complain about when it does not.
   */
  const awaitingPayment = await many(
    `SELECT c.reference, c.title, c.total_amount, c.currency, c.decided_at,
            u.display_name AS claimant_name,
            TIMESTAMPDIFF(DAY, c.decided_at, NOW(3)) AS days_waiting
       FROM expense_claims c
       JOIN users u ON u.id = c.claimant_id
      WHERE c.company_id = $1 AND c.status = 'approved'
      ORDER BY c.decided_at
      LIMIT 100`,
    [actor.companyId],
  );
  const budgets = await many(
    `SELECT name, currency, amount, committed_amount, spent_amount,
            (amount - committed_amount - spent_amount) AS remaining,
            CASE WHEN amount > 0
                 THEN ROUND(((committed_amount + spent_amount) / amount) * 100)
                 ELSE 0 END AS used_percent
       FROM budgets
      WHERE company_id = $1 AND period_end >= CURDATE()
      ORDER BY used_percent DESC`,
    [actor.companyId],
  );

  return { byMonth, byCategory, awaitingPayment, budgets };
}

/** Leave taken, and who is off in the next month. */
export async function leave(actor: Actor): Promise<Overview> {
  await authorize({ actor, capability: 'report.read', resourceless: true });

  const byType = await many(
    `SELECT t.name AS type_name, t.colour, SUM(r.working_days) AS days, COUNT(*) AS requests
       FROM leave_requests r
       JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.company_id = $1 AND r.status = 'approved'
        AND r.start_date > DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
      GROUP BY t.name, t.colour
      ORDER BY days DESC`,
    [actor.companyId],
  );
  const upcoming = await many(
    `SELECT u.display_name, t.name AS type_name, r.start_date, r.end_date, r.working_days
       FROM leave_requests r
       JOIN users u ON u.id = r.user_id
       JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.company_id = $1 AND r.status = 'approved'
        AND r.end_date >= CURDATE() AND r.start_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
      ORDER BY r.start_date
      LIMIT 100`,
    [actor.companyId],
  );
  // People carrying most of their entitlement late in the year are a burnout signal and a
  // year-end scheduling problem, so they are worth surfacing rather than computing later.
  const unused = await many(
    `SELECT u.display_name, t.name AS type_name,
            (b.entitled_days + b.carried_days - b.taken_days - b.pending_days) AS remaining,
            (b.entitled_days + b.carried_days) AS entitled
       FROM leave_balances b
       JOIN users u ON u.id = b.user_id
       JOIN leave_types t ON t.id = b.leave_type_id
      WHERE b.company_id = $1 AND b.year = YEAR(CURDATE())
        AND t.deducts_balance AND (b.entitled_days + b.carried_days) > 0
        AND (b.entitled_days + b.carried_days - b.taken_days - b.pending_days)
            > (b.entitled_days + b.carried_days) * 0.6
        AND u.status = 'active'
      ORDER BY remaining DESC
      LIMIT 50`,
    [actor.companyId],
  );

  return { byType, upcoming, unusedLeave: unused };
}

/** Equipment, including the items nobody can return because they have left. */
export async function assets(actor: Actor): Promise<Overview> {
  await authorize({ actor, capability: 'report.read', resourceless: true });

  const byStatus = await many(
    'SELECT status, COUNT(*) AS count FROM assets WHERE company_id = $1 GROUP BY status',
    [actor.companyId],
  );
  const value = await one<{ total: number }>(
    `SELECT COALESCE(SUM(purchase_cost), 0) AS total FROM assets
      WHERE company_id = $1 AND status <> 'retired'`,
    [actor.companyId],
  );
  /**
   * Equipment still assigned to somebody who has left.
   *
   * Offboarding warns about this at the time, but a warning only helps the person doing
   * the offboarding on that day. This is the standing list of what was missed.
   */
  const withDepartedStaff = await many(
    `SELECT a.asset_tag, a.name, a.serial_number, u.display_name AS holder_name,
            u.status AS holder_status, u.offboarded_at
       FROM assets a
       JOIN users u ON u.id = a.assigned_to
      WHERE a.company_id = $1 AND u.status IN ('offboarded','suspended')
      ORDER BY u.offboarded_at`,
    [actor.companyId],
  );

  return {
    byStatus,
    totalPurchaseValue: Number(value?.total ?? 0),
    withDepartedStaff,
  };
}

/** Everything at once, for the reporting landing page. */
export async function overview(actor: Actor): Promise<Overview> {
  const [people, decisions, money, timeOff, equipment] = await Promise.all([
    headcount(actor),
    approvals(actor),
    spend(actor),
    leave(actor),
    assets(actor),
  ]);
  return { headcount: people, approvals: decisions, spend: money, leave: timeOff, assets: equipment };
}
