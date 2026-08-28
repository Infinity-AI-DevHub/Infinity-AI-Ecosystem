/**
 * Approvals domain (blueprint 04/03).
 *
 * Configurable request types, conditional routing by amount and department, sequential
 * and parallel approvers, delegation, expiry/escalation, and an immutable decision
 * history. A requester can never be the final approver of their own request.
 */
import { many, newId, one, pool, reload, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { assertSeparationOfDuties, authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';

export type DefinitionRow = {
  id: string;
  company_id: string;
  key: string;
  name: string;
  schema_version: number;
  form_schema: unknown;
  routing: RoutingRule[];
  active: boolean;
};

export type ApproverSpec = {
  type: 'manager' | 'user' | 'access_level';
  value?: string;
  /**
   * Used when the primary spec resolves to nobody.
   *
   * The common case is a `manager` step for someone at the top of the reporting line:
   * a chief executive has no manager, and without a fallback they could never raise a
   * request at all. The fallback keeps the control (someone still approves) while
   * making the route resolvable for everyone.
   */
  fallback?: { type: 'user' | 'access_level'; value?: string };
};

/**
 * A routing rule matches on amount and department, then names the approvers for a step.
 * `approver` is resolved at request time: 'manager' walks the reporting line.
 */
export type RoutingRule = {
  step: number;
  mode?: 'sequential' | 'parallel';
  minAmount?: number;
  maxAmount?: number;
  departmentIds?: string[];
  approver: ApproverSpec;
  /**
   * When true the step is skipped if it resolves to nobody, provided some other step
   * still does. Approvals never silently proceed unapproved: if no step resolves the
   * request is refused outright.
   */
  optional?: boolean;
  dueHours?: number;
};

export type RequestRow = {
  id: string;
  company_id: string;
  definition_id: string;
  reference: string;
  requester_id: string;
  title: string;
  amount: number | null;
  currency: string;
  data: Record<string, unknown>;
  status: string;
  current_step: number;
  due_at: Date | null;
  version: number;
  created_at: Date;
};

export async function listDefinitions(actor: Actor) {
  return many<DefinitionRow>(
    'SELECT * FROM approval_definitions WHERE company_id = $1 AND active ORDER BY name',
    [actor.companyId],
  );
}

/** Resolves one approver spec into concrete, currently-active user IDs. */
async function resolveSpec(
  companyId: string,
  requester: { id: string; manager_id: string | null; department_id: string | null },
  spec: { type: string; value?: string },
): Promise<string[]> {
  switch (spec.type) {
    case 'manager': {
      if (!requester.manager_id) return [];
      // A manager who has since been suspended cannot hold up the queue.
      const row = await one<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'`,
        [requester.manager_id, companyId],
      );
      return row ? [row.id] : [];
    }
    case 'user': {
      if (!spec.value) return [];
      const row = await one<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'`,
        [spec.value, companyId],
      );
      return row ? [row.id] : [];
    }
    case 'access_level': {
      const rows = await many<{ id: string }>(
        `SELECT id FROM users WHERE company_id = $1 AND access_level = $2 AND status = 'active'`,
        [companyId, spec.value ?? 'admin'],
      );
      return rows.map((r) => r.id);
    }
    default:
      return [];
  }
}

/**
 * Resolves a routing rule into approver IDs, applying the fallback when the primary
 * spec yields nobody.
 */
async function resolveApprovers(
  companyId: string,
  requester: { id: string; manager_id: string | null; department_id: string | null },
  rule: RoutingRule,
): Promise<string[]> {
  const primary = await resolveSpec(companyId, requester, rule.approver);
  if (primary.length > 0) return primary;
  if (!rule.approver.fallback) return [];
  return resolveSpec(companyId, requester, rule.approver.fallback);
}

function ruleApplies(rule: RoutingRule, amount: number | null, departmentId: string | null): boolean {
  if (rule.minAmount !== undefined && (amount ?? 0) < rule.minAmount) return false;
  if (rule.maxAmount !== undefined && (amount ?? 0) > rule.maxAmount) return false;
  if (rule.departmentIds?.length && (!departmentId || !rule.departmentIds.includes(departmentId))) {
    return false;
  }
  return true;
}

export async function createRequest(
  actor: Actor,
  input: { definitionKey: string; title: string; amount?: number | null; currency?: string; data?: Record<string, unknown> },
  correlationId: string,
): Promise<RequestRow> {
  await authorize({ actor, capability: 'request.create', resourceless: true });
  const definition = await one<DefinitionRow>(
    'SELECT * FROM approval_definitions WHERE company_id = $1 AND `key` = $2 AND active',
    [actor.companyId, input.definitionKey],
  );
  if (!definition) throw notFound('That request type is not available');

  const requester = await one<{ id: string; manager_id: string | null; department_id: string | null }>(
    'SELECT id, manager_id, department_id FROM users WHERE id = $1',
    [actor.userId],
  );
  if (!requester) throw notFound('Requester not found');

  const rules = (definition.routing ?? []).filter((rule) =>
    ruleApplies(rule, input.amount ?? null, requester.department_id),
  );
  if (rules.length === 0) {
    throw unprocessable('No approval route matches this request', [
      { field: 'amount', message: 'Ask an administrator to configure a route for this amount or department' },
    ]);
  }

  // Separation of duties is applied here as well as at decision time: a step that would
  // resolve only to the requester is not a real approval, so it is treated as unresolved.
  const resolved: { rule: RoutingRule; approvers: string[] }[] = [];
  const skipped: RoutingRule[] = [];
  for (const rule of rules.sort((a, b) => a.step - b.step)) {
    const approvers = (await resolveApprovers(actor.companyId, requester, rule)).filter(
      (id) => id !== actor.userId,
    );
    if (approvers.length > 0) {
      resolved.push({ rule, approvers });
      continue;
    }
    if (rule.optional) {
      skipped.push(rule);
      continue;
    }
    throw unprocessable('This request cannot be routed', [
      {
        field: 'definitionKey',
        message:
          rule.approver.type === 'manager'
            ? 'No manager is assigned to you, and this request type has no fallback approver. ' +
              'Ask an administrator to set your manager or configure a fallback.'
            : 'No eligible approver is configured for this step',
      },
    ]);
  }

  // Every step being skippable would mean nobody approves. That is never acceptable.
  if (resolved.length === 0) {
    throw unprocessable('This request cannot be routed', [
      {
        field: 'definitionKey',
        message:
          skipped.length > 0
            ? 'No approver could be resolved for any step of this request type'
            : 'This request type has no approval steps configured',
      },
    ]);
  }

  const firstRule = resolved[0]!.rule;
  const request = await transaction(async (tx) => {
    // Lock the company row so two simultaneous requests cannot mint the same reference.
    await tx.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [actor.companyId]);
    const seqRes = await tx.query<{ next: number }>(
      `SELECT count(*) + 1 AS next FROM approval_requests WHERE company_id = $1`,
      [actor.companyId],
    );
    const reference = `${definition.key.toUpperCase()}-${String(seqRes.rows[0]?.next ?? 1).padStart(5, '0')}`;

    const requestId = newId();
    await tx.query(
      `INSERT INTO approval_requests
         (id, company_id, definition_id, reference, requester_id, title, amount, currency,
          data, current_step, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, DATE_ADD(NOW(3), INTERVAL $11 HOUR))`,
      [
        requestId,
        actor.companyId,
        definition.id,
        reference,
        actor.userId,
        input.title.trim(),
        input.amount ?? null,
        input.currency ?? 'USD',
        JSON.stringify(input.data ?? {}),
        resolved[0]!.rule.step,
        firstRule.dueHours ?? 72,
      ],
    );
    const created = (await reload<RequestRow>(tx, 'approval_requests', requestId))!;

    for (const { rule, approvers } of resolved) {
      for (const approverId of approvers) {
        await tx.query(
          `INSERT IGNORE INTO approval_steps
             (id, company_id, request_id, step_number, approver_id, mode, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            newId(),
            actor.companyId,
            created.id,
            rule.step,
            approverId,
            rule.mode ?? 'sequential',
            rule.step === created.current_step ? 'active' : 'waiting',
          ],
        );
      }
    }

    await auditFromActor(
      actor,
      'approval.request',
      { resourceType: 'approval_request', resourceId: created.id, correlationId,
        metadata: { reference, amount: input.amount ?? null, definition: definition.key } },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'approval.requested',
        actorId: actor.userId,
        correlationId,
        payload: {
          requestId: created.id,
          reference,
          approverIds: resolved[0]!.approvers,
          title: created.title,
        },
      },
      tx,
    );
    return created;
  });

  return request;
}

export async function listRequests(
  actor: Actor,
  filters: { scope: 'mine' | 'pending_me' | 'all'; status?: string; limit: number },
) {
  if (filters.scope === 'all') {
    await authorize({ actor, capability: 'approval.report', resourceless: true });
  }
  return many(
    `SELECT r.*, d.name AS definition_name, u.display_name AS requester_name,
            EXISTS (
              SELECT 1 FROM approval_steps s
               WHERE s.request_id = r.id AND s.approver_id = $2
                 AND s.step_number = r.current_step AND s.state = 'active'
            ) AS awaiting_me
       FROM approval_requests r
       JOIN approval_definitions d ON d.id = r.definition_id
       JOIN users u ON u.id = r.requester_id
      WHERE r.company_id = $1
        AND ($3 IS NULL OR r.status = $3)
        AND (
          ($4 = 'mine' AND r.requester_id = $2)
          OR ($4 = 'all')
          OR ($4 = 'pending_me' AND r.status = 'pending' AND EXISTS (
               SELECT 1 FROM approval_steps s
                WHERE s.request_id = r.id AND s.approver_id = $2
                  AND s.step_number = r.current_step AND s.state = 'active'))
        )
      ORDER BY r.created_at DESC
      LIMIT $5`,
    [actor.companyId, actor.userId, filters.status ?? null, filters.scope, filters.limit],
  );
}

export async function getRequest(actor: Actor, requestId: string) {
  const request = await one<RequestRow & { requester_name: string; definition_name: string }>(
    `SELECT r.*, u.display_name AS requester_name, d.name AS definition_name
       FROM approval_requests r
       JOIN users u ON u.id = r.requester_id
       JOIN approval_definitions d ON d.id = r.definition_id
      WHERE r.id = $1 AND r.company_id = $2`,
    [requestId, actor.companyId],
  );
  if (!request) throw notFound('Request not found');

  const steps = await many(
    `SELECT s.step_number, s.state, s.mode, s.approver_id, u.display_name AS approver_name
       FROM approval_steps s JOIN users u ON u.id = s.approver_id
      WHERE s.request_id = $1 ORDER BY s.step_number, u.display_name`,
    [requestId],
  );
  const isApprover = steps.some((s) => (s as { approver_id: string }).approver_id === actor.userId);
  await authorize({
    actor,
    capability: 'request.create',
    resourceType: 'approval_request',
    resourceId: requestId,
    membership: isApprover || request.requester_id === actor.userId,
  });

  const decisions = await many(
    `SELECT d.step_number, d.decision, d.comment, d.created_at, u.display_name AS approver_name
       FROM approval_decisions d JOIN users u ON u.id = d.approver_id
      WHERE d.request_id = $1 ORDER BY d.created_at`,
    [requestId],
  );
  return { ...request, steps, decisions };
}

/**
 * Records a decision. Idempotent at the API layer via Idempotency-Key; here the step
 * state transition itself guarantees a second decision on the same step cannot apply.
 */
export async function decide(
  actor: Actor,
  requestId: string,
  input: { decision: 'approved' | 'rejected' | 'returned'; comment?: string },
  correlationId: string,
): Promise<RequestRow> {
  await authorize({ actor, capability: 'decision.make', resourceless: true });

  return transaction(async (tx) => {
    const requestRes = await tx.query<RequestRow>(
      'SELECT * FROM approval_requests WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [requestId, actor.companyId],
    );
    const request = requestRes.rows[0];
    if (!request) throw notFound('Request not found');
    if (request.status !== 'pending') throw conflict(`This request is already ${request.status}`);

    // Separation of duties: the requester may never approve their own request.
    assertSeparationOfDuties(actor.userId, request.requester_id);

    const stepRes = await tx.query<{ id: string; mode: string }>(
      `SELECT id, mode FROM approval_steps
        WHERE request_id = $1 AND approver_id = $2 AND step_number = $3 AND state = 'active'
        FOR UPDATE`,
      [requestId, actor.userId, request.current_step],
    );
    const step = stepRes.rows[0];
    if (!step) throw forbidden('This request is not waiting for your decision');

    await tx.query(
      `INSERT INTO approval_decisions
         (id, company_id, request_id, step_number, approver_id, decision, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId(),
        actor.companyId,
        requestId,
        request.current_step,
        actor.userId,
        input.decision,
        input.comment ?? null,
      ],
    );
    await tx.query(`UPDATE approval_steps SET state = 'done' WHERE id = $1`, [step.id]);

    let finalStatus = request.status;
    let nextStep = request.current_step;

    if (input.decision === 'rejected' || input.decision === 'returned') {
      // A rejection or return ends the round immediately.
      finalStatus = input.decision === 'rejected' ? 'rejected' : 'returned';
      await tx.query(
        `UPDATE approval_steps SET state = 'skipped' WHERE request_id = $1 AND state <> 'done'`,
        [requestId],
      );
    } else {
      // Parallel steps need every approver on the step to have decided.
      const remaining = await tx.query<{ count: number }>(
        `SELECT count(*) AS count FROM approval_steps
          WHERE request_id = $1 AND step_number = $2 AND state = 'active'`,
        [requestId, request.current_step],
      );
      const stepComplete = step.mode === 'sequential' || (remaining.rows[0]?.count ?? 0) === 0;
      if (stepComplete) {
        if (step.mode === 'sequential') {
          await tx.query(
            `UPDATE approval_steps SET state = 'skipped'
              WHERE request_id = $1 AND step_number = $2 AND state = 'active'`,
            [requestId, request.current_step],
          );
        }
        const next = await tx.query<{ step_number: number }>(
          `SELECT min(step_number) AS step_number FROM approval_steps
            WHERE request_id = $1 AND state = 'waiting'`,
          [requestId],
        );
        const nextNumber = next.rows[0]?.step_number ?? null;
        if (nextNumber === null) {
          finalStatus = 'approved';
        } else {
          nextStep = nextNumber;
          await tx.query(
            `UPDATE approval_steps SET state = 'active' WHERE request_id = $1 AND step_number = $2`,
            [requestId, nextNumber],
          );
        }
      }
    }

    await tx.query(
      `UPDATE approval_requests SET status = $2, current_step = $3, version = version + 1, updated_at = NOW(3)
        WHERE id = $1`,
      [requestId, finalStatus, nextStep],
    );

    await auditFromActor(
      actor,
      'approval.decision',
      { resourceType: 'approval_request', resourceId: requestId, correlationId,
        before: { status: request.status, step: request.current_step },
        after: { status: finalStatus, step: nextStep },
        metadata: { decision: input.decision, reference: request.reference } },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: finalStatus === 'pending' ? 'approval.decided' : 'approval.completed',
        actorId: actor.userId,
        correlationId,
        payload: {
          requestId,
          reference: request.reference,
          decision: input.decision,
          status: finalStatus,
          requesterId: request.requester_id,
          nextStep: finalStatus === 'pending' ? nextStep : null,
        },
      },
      tx,
    );
    return (await reload<RequestRow>(tx, 'approval_requests', requestId))!;
  });
}

export async function cancelRequest(actor: Actor, requestId: string): Promise<void> {
  const request = await one<RequestRow>(
    'SELECT * FROM approval_requests WHERE id = $1 AND company_id = $2',
    [requestId, actor.companyId],
  );
  if (!request) throw notFound('Request not found');
  if (request.requester_id !== actor.userId && !actor.capabilities.has('definition.manage')) {
    throw forbidden('Only the requester can cancel this request');
  }
  if (request.status !== 'pending') throw conflict(`This request is already ${request.status}`);
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE approval_requests SET status = 'cancelled', version = version + 1, updated_at = NOW(3) WHERE id = $1`,
      [requestId],
    );
    await tx.query(`UPDATE approval_steps SET state = 'skipped' WHERE request_id = $1 AND state <> 'done'`, [
      requestId,
    ]);
    await auditFromActor(actor, 'approval.cancel', { resourceType: 'approval_request', resourceId: requestId }, tx);
  });
}

/** Escalation: overdue pending requests notify the next approver's manager. */
export async function escalateOverdue(): Promise<number> {
  const overdue = await many<{ id: string; company_id: string; reference: string; current_step: number }>(
    `SELECT id, company_id, reference, current_step FROM approval_requests
      WHERE status = 'pending' AND due_at IS NOT NULL AND due_at < NOW(3)
      LIMIT 100`,
  );
  for (const request of overdue) {
    await emit({
      companyId: request.company_id,
      type: 'approval.decided',
      payload: { requestId: request.id, reference: request.reference, escalated: true },
    });
    await pool.query(
      `UPDATE approval_requests
          SET due_at = DATE_ADD(NOW(3), INTERVAL 24 HOUR), updated_at = NOW(3)
        WHERE id = $1`,
      [request.id],
    );
  }
  return overdue.length;
}
