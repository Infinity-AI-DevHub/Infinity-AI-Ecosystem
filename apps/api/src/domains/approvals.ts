/**
 * Approvals domain (blueprint 04/03).
 *
 * Configurable request types, conditional routing by amount and department, sequential
 * and parallel approvers, delegation, expiry/escalation, and an immutable decision
 * history. A requester can never be the final approver of their own request.
 */
import { many, one, pool, transaction } from '../core/db.js';
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
  approver: { type: 'manager' | 'user' | 'access_level'; value?: string };
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

/** Resolves a routing rule into concrete approver user IDs. */
async function resolveApprovers(
  companyId: string,
  requester: { id: string; manager_id: string | null; department_id: string | null },
  rule: RoutingRule,
): Promise<string[]> {
  switch (rule.approver.type) {
    case 'manager': {
      if (!requester.manager_id) return [];
      return [requester.manager_id];
    }
    case 'user': {
      if (!rule.approver.value) return [];
      const row = await one<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'`,
        [rule.approver.value, companyId],
      );
      return row ? [row.id] : [];
    }
    case 'access_level': {
      const rows = await many<{ id: string }>(
        `SELECT id FROM users WHERE company_id = $1 AND access_level = $2 AND status = 'active'`,
        [companyId, rule.approver.value ?? 'admin'],
      );
      return rows.map((r) => r.id);
    }
    default:
      return [];
  }
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
    'SELECT * FROM approval_definitions WHERE company_id = $1 AND key = $2 AND active',
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

  // Every step must resolve to at least one approver who is not the requester.
  const resolved: { rule: RoutingRule; approvers: string[] }[] = [];
  for (const rule of rules.sort((a, b) => a.step - b.step)) {
    const approvers = (await resolveApprovers(actor.companyId, requester, rule)).filter(
      (id) => id !== actor.userId,
    );
    if (approvers.length === 0) {
      throw unprocessable('This request cannot be routed', [
        {
          field: 'definitionKey',
          message:
            rule.approver.type === 'manager'
              ? 'No manager is assigned to you; ask an administrator to set one'
              : 'No eligible approver is configured for this step',
        },
      ]);
    }
    resolved.push({ rule, approvers });
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

    const res = await tx.query<RequestRow>(
      `INSERT INTO approval_requests
         (company_id, definition_id, reference, requester_id, title, amount, currency, data, current_step, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' hours')::interval)
       RETURNING *`,
      [
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
    const created = res.rows[0]!;

    for (const { rule, approvers } of resolved) {
      for (const approverId of approvers) {
        await tx.query(
          `INSERT INTO approval_steps (company_id, request_id, step_number, approver_id, mode, state)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [
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
        AND ($3::text IS NULL OR r.status = $3)
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
      `INSERT INTO approval_decisions (company_id, request_id, step_number, approver_id, decision, comment)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor.companyId, requestId, request.current_step, actor.userId, input.decision, input.comment ?? null],
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
        `SELECT count(*)::int AS count FROM approval_steps
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

    const updated = await tx.query<RequestRow>(
      `UPDATE approval_requests SET status = $2, current_step = $3, version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
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
    return updated.rows[0]!;
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
      `UPDATE approval_requests SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1`,
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
      WHERE status = 'pending' AND due_at IS NOT NULL AND due_at < now()
      LIMIT 100`,
  );
  for (const request of overdue) {
    await emit({
      companyId: request.company_id,
      type: 'approval.decided',
      payload: { requestId: request.id, reference: request.reference, escalated: true },
    });
    await pool.query(
      `UPDATE approval_requests SET due_at = now() + interval '24 hours', updated_at = now() WHERE id = $1`,
      [request.id],
    );
  }
  return overdue.length;
}
