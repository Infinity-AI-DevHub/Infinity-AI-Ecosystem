/**
 * Expenses, budgets, vendors and the asset register.
 *
 * The approvals engine could already route an expense request, but nothing sat
 * underneath it: someone could ask for four hundred pounds of travel and the system held
 * no receipt, no reimbursement status and no record of which budget it came from. This
 * is the substance the workflow was missing.
 *
 * Three things shape the design. Money is DECIMAL end to end, because floating point
 * cannot represent 0.10 and an accounting record that is nearly right is wrong.
 * Reimbursement is tracked apart from approval, because an approved claim nobody has
 * paid is the commonest complaint about expense systems and it is invisible unless the
 * two states are separate. And a claim is approved as one decision rather than per
 * receipt, because approving eleven receipts individually is how these systems become
 * hated.
 */
import { many, newId, one, pool, reload, transaction } from '../core/db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { authorize, assertSeparationOfDuties, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import * as approvals from './approvals.js';

export type ClaimRow = {
  id: string;
  company_id: string;
  claimant_id: string;
  reference: string;
  title: string;
  currency: string;
  total_amount: string;
  status: string;
  approval_request_id: string | null;
  budget_id: string | null;
  reimbursed_at: Date | null;
  payment_reference: string | null;
};

export type ItemInput = {
  categoryId?: string | null;
  spentOn: string;
  merchant?: string | null;
  description?: string | null;
  amount: number;
  taxAmount?: number;
  receiptFileId?: string | null;
};

const money = (value: string | number) => Number(Number(value).toFixed(2));

// ------------------------------------------------------------------ categories

export async function listCategories(actor: Actor) {
  return many(
    'SELECT * FROM expense_categories WHERE company_id = $1 AND active ORDER BY name',
    [actor.companyId],
  );
}

export async function createCategory(
  actor: Actor,
  input: { key: string; name: string; limitAmount?: number | null; requiresReceiptAbove?: number },
) {
  await authorize({ actor, capability: 'budget.manage', resourceless: true });
  const key = input.key.trim().toLowerCase();
  const existing = await one<{ id: string }>(
    'SELECT id FROM expense_categories WHERE company_id = $1 AND `key` = $2',
    [actor.companyId, key],
  );
  if (existing) throw conflict('That category already exists');

  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO expense_categories (id, company_id, \`key\`, name, limit_amount, requires_receipt_above)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, actor.companyId, key, input.name.trim(), input.limitAmount ?? null, input.requiresReceiptAbove ?? 0],
    );
    await auditFromActor(actor, 'expense.category_create', {
      resourceType: 'company',
      resourceId: actor.companyId,
      metadata: { key, name: input.name },
    }, tx);
    return (await reload(tx, 'expense_categories', id))!;
  });
}

// ------------------------------------------------------------------ claims

async function nextReference(companyId: string, tx: { query: (s: string, p: unknown[]) => Promise<{ rows: { next: number }[] }> }) {
  const seq = await tx.query(
    "SELECT COUNT(*) + 1 AS next FROM expense_claims WHERE company_id = $1",
    [companyId],
  );
  return `EXP-${String(seq.rows[0]?.next ?? 1).padStart(5, '0')}`;
}

/**
 * Creates a claim with its lines.
 *
 * The total is computed from the items rather than accepted from the caller: a client
 * that can name its own total is a client that can be made to name the wrong one.
 * Receipt rules are enforced per category here, at the point the claim is assembled,
 * rather than being left to whoever approves it to notice.
 */
export async function createClaim(
  actor: Actor,
  input: { title: string; currency?: string; budgetId?: string | null; items: ItemInput[] },
): Promise<ClaimRow> {
  await authorize({ actor, capability: 'expense.submit', resourceless: true });
  if (input.items.length === 0) {
    throw unprocessable('A claim needs at least one line', [
      { field: 'items', message: 'Add what you are claiming for' },
    ]);
  }

  const categories = await many<{ id: string; name: string; limit_amount: string | null; requires_receipt_above: string }>(
    'SELECT id, name, limit_amount, requires_receipt_above FROM expense_categories WHERE company_id = $1',
    [actor.companyId],
  );
  const byId = new Map(categories.map((c) => [c.id, c]));

  let total = 0;
  input.items.forEach((item, index) => {
    if (item.amount <= 0) {
      throw unprocessable('Every line needs an amount above zero', [
        { field: `items.${index}.amount`, message: 'Enter what it cost' },
      ]);
    }
    const category = item.categoryId ? byId.get(item.categoryId) : undefined;
    if (category?.limit_amount !== null && category?.limit_amount !== undefined) {
      if (item.amount > Number(category.limit_amount)) {
        throw unprocessable(
          `${category.name} is capped at ${category.limit_amount} per item`,
          [{ field: `items.${index}.amount`, message: 'Split it or use a different category' }],
        );
      }
    }
    const threshold = Number(category?.requires_receipt_above ?? 0);
    if (category && item.amount > threshold && !item.receiptFileId) {
      throw unprocessable(
        `${category.name} needs a receipt above ${threshold}`,
        [{ field: `items.${index}.receiptFileId`, message: 'Attach the receipt' }],
      );
    }
    total += item.amount + (item.taxAmount ?? 0);
  });

  const id = newId();
  return transaction(async (tx) => {
    const reference = await nextReference(actor.companyId, tx as never);
    await tx.query(
      `INSERT INTO expense_claims
         (id, company_id, claimant_id, reference, title, currency, total_amount, budget_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft')`,
      [id, actor.companyId, actor.userId, reference, input.title.trim(), input.currency ?? 'USD', money(total), input.budgetId ?? null],
    );
    for (const item of input.items) {
      await tx.query(
        `INSERT INTO expense_items
           (id, claim_id, category_id, spent_on, merchant, description, amount, tax_amount, receipt_file_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          newId(),
          id,
          item.categoryId ?? null,
          item.spentOn,
          item.merchant?.trim() || null,
          item.description?.trim() || null,
          money(item.amount),
          money(item.taxAmount ?? 0),
          item.receiptFileId ?? null,
        ],
      );
    }
    await auditFromActor(actor, 'expense.create', {
      resourceType: 'expense_claim',
      resourceId: id,
      metadata: { reference, total: money(total), currency: input.currency ?? 'USD' },
    }, tx);
    return (await reload<ClaimRow>(tx, 'expense_claims', id))!;
  });
}

/**
 * Submits a draft for approval and commits the money against its budget.
 *
 * Committing at submission rather than at payment is deliberate: a budget that only
 * counts what has already been paid tells a manager they have money they have in fact
 * promised away.
 */
export async function submitClaim(
  actor: Actor,
  claimId: string,
  correlationId: string,
): Promise<ClaimRow> {
  const claim = await getClaim(actor, claimId);
  if (claim.claimant_id !== actor.userId) {
    throw forbidden('Only the claimant can submit their own claim');
  }
  if (claim.status !== 'draft') throw conflict('This claim has already been submitted');

  await transaction(async (tx) => {
    await tx.query(
      "UPDATE expense_claims SET status = 'submitted', submitted_at = NOW(3) WHERE id = $1 AND status = 'draft'",
      [claimId],
    );
    if (claim.budget_id) {
      await tx.query(
        'UPDATE budgets SET committed_amount = committed_amount + $2 WHERE id = $1',
        [claim.budget_id, claim.total_amount],
      );
    }
    await auditFromActor(actor, 'expense.submit', {
      resourceType: 'expense_claim',
      resourceId: claimId,
      metadata: { reference: claim.reference, total: claim.total_amount },
    }, tx);
  });

  const approval = await approvals.createRequest(
    actor,
    {
      definitionKey: 'expense',
      title: `${claim.reference}: ${claim.title}`,
      amount: Number(claim.total_amount),
      currency: claim.currency,
      data: { expenseClaimId: claimId, reference: claim.reference },
    },
    correlationId,
  );
  await one('UPDATE expense_claims SET approval_request_id = $2 WHERE id = $1', [claimId, approval.id]);

  return { ...claim, status: 'submitted', approval_request_id: approval.id };
}

/** Applies an approval decision to the claim behind it. Driven by the approval event. */
export async function settleClaimDecision(
  claimId: string,
  decision: 'approved' | 'rejected',
): Promise<void> {
  await transaction(async (tx) => {
    const claim = await one<ClaimRow>(
      "SELECT * FROM expense_claims WHERE id = $1 AND status = 'submitted'",
      [claimId],
    );
    if (!claim) return;

    await tx.query(
      'UPDATE expense_claims SET status = $2, decided_at = NOW(3) WHERE id = $1',
      [claimId, decision],
    );
    // A rejected claim releases the commitment; an approved one keeps it until paid.
    if (decision === 'rejected' && claim.budget_id) {
      await tx.query(
        'UPDATE budgets SET committed_amount = GREATEST(committed_amount - $2, 0) WHERE id = $1',
        [claim.budget_id, claim.total_amount],
      );
    }
  });
}

/**
 * Records that a claim has actually been paid.
 *
 * Separation of duties: whoever approved a claim may not also be the one who marks it
 * paid. Approving your own reimbursement and then recording the payment is the shape of
 * the most ordinary expense fraud there is.
 */
export async function reimburseClaim(
  actor: Actor,
  claimId: string,
  input: { paymentReference: string },
): Promise<ClaimRow> {
  await authorize({ actor, capability: 'expense.reimburse', resourceless: true });
  const claim = await getClaim(actor, claimId);
  if (claim.status !== 'approved') throw conflict('Only an approved claim can be marked paid');
  assertSeparationOfDuties(actor.userId, claim.claimant_id);

  if (claim.approval_request_id) {
    // Read from approval_decisions, which records who actually decided. The step table
    // tracks progress with states of done/active/waiting and never says 'approved', so
    // querying it for that value silently matched nothing - a separation-of-duties check
    // that never fires is worse than none, because it reads as though it does.
    const approvers = await many<{ approver_id: string }>(
      `SELECT approver_id FROM approval_decisions
        WHERE request_id = $1 AND decision = 'approved'`,
      [claim.approval_request_id],
    );
    if (approvers.some((row) => row.approver_id === actor.userId)) {
      throw forbidden(
        'Separation of duties: someone who approved a claim cannot also record its payment',
      );
    }
  }

  return transaction(async (tx) => {
    const paid = await tx.query(
      `UPDATE expense_claims
          SET status = 'reimbursed', reimbursed_at = NOW(3), reimbursed_by = $2, payment_reference = $3
        WHERE id = $1 AND status = 'approved'`,
      [claimId, actor.userId, input.paymentReference.trim()],
    );
    if (paid.rowCount === 0) throw conflict('This claim was already paid');

    // The money has now actually moved: it leaves committed and lands in spent.
    if (claim.budget_id) {
      await tx.query(
        `UPDATE budgets
            SET committed_amount = GREATEST(committed_amount - $2, 0),
                spent_amount = spent_amount + $2
          WHERE id = $1`,
        [claim.budget_id, claim.total_amount],
      );
    }
    await auditFromActor(actor, 'expense.reimburse', {
      resourceType: 'expense_claim',
      resourceId: claimId,
      metadata: { reference: claim.reference, paymentReference: input.paymentReference },
    }, tx);
    return (await reload<ClaimRow>(tx, 'expense_claims', claimId))!;
  });
}

export async function getClaim(actor: Actor, claimId: string): Promise<ClaimRow> {
  const claim = await one<ClaimRow>(
    'SELECT * FROM expense_claims WHERE id = $1 AND company_id = $2',
    [claimId, actor.companyId],
  );
  if (!claim) throw notFound('Claim not found');
  if (claim.claimant_id !== actor.userId) {
    await authorize({ actor, capability: 'expense.read_all', resourceless: true });
  }
  return claim;
}

export async function claimWithItems(actor: Actor, claimId: string) {
  const claim = await getClaim(actor, claimId);
  const items = await many(
    `SELECT i.*, c.name AS category_name, f.name AS receipt_name
       FROM expense_items i
       LEFT JOIN expense_categories c ON c.id = i.category_id
       LEFT JOIN files f ON f.id = i.receipt_file_id
      WHERE i.claim_id = $1
      ORDER BY i.spent_on`,
    [claimId],
  );
  return { ...claim, items };
}

export async function listClaims(
  actor: Actor,
  filters: { mine?: boolean; status?: string } = {},
) {
  const mineOnly = filters.mine !== false;
  if (!mineOnly) await authorize({ actor, capability: 'expense.read_all', resourceless: true });

  return many(
    `SELECT c.*, u.display_name AS claimant_name,
            (SELECT COUNT(*) FROM expense_items i WHERE i.claim_id = c.id) AS item_count
       FROM expense_claims c
       JOIN users u ON u.id = c.claimant_id
      WHERE c.company_id = $1
        AND ($2 IS NULL OR c.claimant_id = $2)
        AND ($3 IS NULL OR c.status = $3)
      ORDER BY c.created_at DESC
      LIMIT 200`,
    [actor.companyId, mineOnly ? actor.userId : null, filters.status ?? null],
  );
}

// ------------------------------------------------------------------ budgets

export async function listBudgets(actor: Actor) {
  await authorize({ actor, capability: 'budget.read', resourceless: true });
  return many(
    `SELECT b.*, d.name AS department_name,
            (b.amount - b.committed_amount - b.spent_amount) AS remaining_amount
       FROM budgets b
       LEFT JOIN departments d ON d.id = b.department_id
      WHERE b.company_id = $1
      ORDER BY b.period_start DESC, b.name`,
    [actor.companyId],
  );
}

export async function createBudget(
  actor: Actor,
  input: {
    name: string;
    departmentId?: string | null;
    periodStart: string;
    periodEnd: string;
    amount: number;
    currency?: string;
  },
) {
  await authorize({ actor, capability: 'budget.manage', resourceless: true });
  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO budgets (id, company_id, department_id, name, period_start, period_end, currency, amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        actor.companyId,
        input.departmentId ?? null,
        input.name.trim(),
        input.periodStart,
        input.periodEnd,
        input.currency ?? 'USD',
        money(input.amount),
        actor.userId,
      ],
    );
    await auditFromActor(actor, 'budget.create', {
      resourceType: 'company',
      resourceId: actor.companyId,
      metadata: { name: input.name, amount: money(input.amount) },
    }, tx);
    return (await reload(tx, 'budgets', id))!;
  });
}

// ------------------------------------------------------------------ vendors

export async function listVendors(actor: Actor) {
  await authorize({ actor, capability: 'vendor.manage', resourceless: true });
  return many(
    `SELECT v.*, o.name AS organization_name
       FROM vendors v
       LEFT JOIN external_organizations o ON o.id = v.organization_id
      WHERE v.company_id = $1 AND v.status = 'active'
      ORDER BY v.name`,
    [actor.companyId],
  );
}

export async function createVendor(
  actor: Actor,
  input: {
    name: string;
    organizationId?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    taxId?: string | null;
    notes?: string | null;
  },
) {
  await authorize({ actor, capability: 'vendor.manage', resourceless: true });
  const existing = await one<{ id: string }>(
    'SELECT id FROM vendors WHERE company_id = $1 AND name = $2',
    [actor.companyId, input.name.trim()],
  );
  if (existing) throw conflict('That vendor already exists');

  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO vendors (id, company_id, name, organization_id, contact_email, contact_phone, tax_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        actor.companyId,
        input.name.trim(),
        input.organizationId ?? null,
        input.contactEmail?.toLowerCase().trim() || null,
        input.contactPhone?.trim() || null,
        input.taxId?.trim() || null,
        input.notes?.trim() || null,
        actor.userId,
      ],
    );
    await auditFromActor(actor, 'vendor.create', {
      resourceType: 'company',
      resourceId: actor.companyId,
      metadata: { name: input.name },
    }, tx);
    return (await reload(tx, 'vendors', id))!;
  });
}

// ------------------------------------------------------------------ assets

export type AssetRow = {
  id: string;
  company_id: string;
  asset_tag: string;
  name: string;
  category: string;
  serial_number: string | null;
  status: string;
  assigned_to: string | null;
  location: string | null;
};

/**
 * Editing a vendor.
 *
 * Retiring rather than deleting: assets record which vendor they were bought from, and
 * removing the row would erase that from every asset's history. A retired vendor leaves
 * the pickers and stays readable everywhere it is already referenced.
 */
export async function updateVendor(
  actor: Actor,
  vendorId: string,
  input: Partial<{
    name: string;
    contactEmail: string | null;
    contactPhone: string | null;
    taxId: string | null;
    notes: string | null;
    status: 'active' | 'archived';
  }>,
) {
  await authorize({ actor, capability: 'vendor.manage', resourceless: true });
  const existing = await one('SELECT id FROM vendors WHERE id = $1 AND company_id = $2', [
    vendorId, actor.companyId,
  ]);
  if (!existing) throw notFound('Vendor not found');
  if (input.name !== undefined && !input.name.trim()) throw badRequest('A vendor needs a name');

  await pool.query(
    `UPDATE vendors
        SET name = COALESCE($3, name),
            contact_email = COALESCE($4, contact_email),
            contact_phone = COALESCE($5, contact_phone),
            tax_id = COALESCE($6, tax_id),
            notes = COALESCE($7, notes),
            status = COALESCE($8, status)
      WHERE id = $1 AND company_id = $2`,
    [
      vendorId, actor.companyId,
      input.name?.trim() ?? null,
      input.contactEmail?.trim().toLowerCase() ?? null,
      input.contactPhone?.trim() ?? null,
      input.taxId?.trim() ?? null,
      input.notes ?? null,
      input.status ?? null,
    ],
  );
  await auditFromActor(actor, 'vendor.update', {
    resourceType: 'vendor', resourceId: vendorId, metadata: { changed: Object.keys(input) },
  });
  return one('SELECT * FROM vendors WHERE id = $1', [vendorId]);
}

export async function archiveVendor(actor: Actor, vendorId: string): Promise<void> {
  await authorize({ actor, capability: 'vendor.manage', resourceless: true });
  const result = await pool.query(
    `UPDATE vendors SET status = 'archived' WHERE id = $1 AND company_id = $2`,
    [vendorId, actor.companyId],
  );
  if (result.rowCount === 0) throw notFound('Vendor not found');
  await auditFromActor(actor, 'vendor.archive', { resourceType: 'vendor', resourceId: vendorId });
}

/**
 * Adjusting a budget.
 *
 * The committed and spent figures are deliberately not editable: they are derived from
 * approved and reimbursed claims, and a hand-edited total would disagree with the claims
 * that produced it.
 */
export async function updateBudget(
  actor: Actor,
  budgetId: string,
  input: Partial<{
    name: string;
    amount: number;
    periodStart: string;
    periodEnd: string;
    status: 'active' | 'closed';
  }>,
) {
  await authorize({ actor, capability: 'budget.manage', resourceless: true });
  const existing = await one<{ spent_amount: string }>(
    'SELECT spent_amount FROM budgets WHERE id = $1 AND company_id = $2',
    [budgetId, actor.companyId],
  );
  if (!existing) throw notFound('Budget not found');
  if (input.amount !== undefined) {
    if (!(input.amount >= 0)) throw badRequest('A budget cannot be negative');
    // Warned about rather than blocked: an overspend is a real situation, and refusing
    // to record the corrected figure does not make it go away.
    if (input.amount < Number(existing.spent_amount)) {
      throw badRequest(
        `That is below the ${existing.spent_amount} already spent. Close this budget and open a new one instead.`,
      );
    }
  }
  if (input.periodStart && input.periodEnd && input.periodEnd < input.periodStart) {
    throw badRequest('The period cannot end before it starts');
  }

  await pool.query(
    `UPDATE budgets
        SET name = COALESCE($3, name),
            amount = COALESCE($4, amount),
            period_start = COALESCE($5, period_start),
            period_end = COALESCE($6, period_end),
            status = COALESCE($7, status)
      WHERE id = $1 AND company_id = $2`,
    [budgetId, actor.companyId, input.name?.trim() ?? null, input.amount ?? null,
     input.periodStart ?? null, input.periodEnd ?? null, input.status ?? null],
  );
  await auditFromActor(actor, 'budget.update', {
    resourceType: 'budget', resourceId: budgetId, metadata: { changed: Object.keys(input) },
  });
  return one('SELECT * FROM budgets WHERE id = $1', [budgetId]);
}

export async function closeBudget(actor: Actor, budgetId: string): Promise<void> {
  await authorize({ actor, capability: 'budget.manage', resourceless: true });
  const result = await pool.query(
    `UPDATE budgets SET status = 'closed' WHERE id = $1 AND company_id = $2`,
    [budgetId, actor.companyId],
  );
  if (result.rowCount === 0) throw notFound('Budget not found');
  await auditFromActor(actor, 'budget.close', { resourceType: 'budget', resourceId: budgetId });
}

/**
 * Editing an expense category.
 *
 * The key is immutable for the same reason a leave type's is: existing claims refer to
 * the category, and re-keying would detach them from what they were filed under.
 */
export async function updateCategory(
  actor: Actor,
  categoryId: string,
  input: Partial<{
    name: string;
    limitAmount: number | null;
    requiresReceiptAbove: number;
    active: boolean;
  }>,
) {
  await authorize({ actor, capability: 'budget.manage', resourceless: true });
  const existing = await one('SELECT id FROM expense_categories WHERE id = $1 AND company_id = $2', [
    categoryId, actor.companyId,
  ]);
  if (!existing) throw notFound('Category not found');
  if (input.name !== undefined && !input.name.trim()) throw badRequest('A category needs a name');
  if (input.limitAmount != null && input.limitAmount < 0) throw badRequest('A limit cannot be negative');

  await pool.query(
    `UPDATE expense_categories
        SET name = COALESCE($3, name),
            limit_amount = COALESCE($4, limit_amount),
            requires_receipt_above = COALESCE($5, requires_receipt_above),
            active = COALESCE($6, active)
      WHERE id = $1 AND company_id = $2`,
    [categoryId, actor.companyId, input.name?.trim() ?? null, input.limitAmount ?? null,
     input.requiresReceiptAbove ?? null, input.active ?? null],
  );
  await auditFromActor(actor, 'expense_category.update', {
    resourceType: 'expense_category', resourceId: categoryId, metadata: { changed: Object.keys(input) },
  });
  return one('SELECT * FROM expense_categories WHERE id = $1', [categoryId]);
}

/**
 * Editing an asset.
 *
 * Its assignment is not changed here - that goes through assignAsset, which writes the
 * custody history. Editing the record and moving the equipment are different acts.
 */
export async function updateAsset(
  actor: Actor,
  assetId: string,
  input: Partial<{
    name: string;
    category: string;
    serialNumber: string | null;
    vendorId: string | null;
    purchasedOn: string | null;
    purchaseCost: number | null;
    warrantyUntil: string | null;
    location: string | null;
    notes: string | null;
    status: string;
  }>,
) {
  await authorize({ actor, capability: 'asset.manage', resourceless: true });
  const existing = await one<{ assigned_to: string | null }>(
    'SELECT assigned_to FROM assets WHERE id = $1 AND company_id = $2',
    [assetId, actor.companyId],
  );
  if (!existing) throw notFound('Asset not found');
  if (input.status === 'retired' && existing.assigned_to) {
    throw conflict('This asset is still assigned to someone. Return it before retiring it.');
  }

  await pool.query(
    `UPDATE assets
        SET name = COALESCE($3, name),
            category = COALESCE($4, category),
            serial_number = COALESCE($5, serial_number),
            vendor_id = COALESCE($6, vendor_id),
            purchased_on = COALESCE($7, purchased_on),
            purchase_cost = COALESCE($8, purchase_cost),
            warranty_until = COALESCE($9, warranty_until),
            location = COALESCE($10, location),
            notes = COALESCE($11, notes),
            status = COALESCE($12, status)
      WHERE id = $1 AND company_id = $2`,
    [assetId, actor.companyId, input.name?.trim() ?? null, input.category ?? null,
     input.serialNumber ?? null, input.vendorId ?? null, input.purchasedOn ?? null,
     input.purchaseCost ?? null, input.warrantyUntil ?? null, input.location ?? null,
     input.notes ?? null, input.status ?? null],
  );
  await auditFromActor(actor, 'asset.update', {
    resourceType: 'asset', resourceId: assetId, metadata: { changed: Object.keys(input) },
  });
  return one('SELECT * FROM assets WHERE id = $1', [assetId]);
}

export async function listAssets(
  actor: Actor,
  filters: { status?: string; assignedTo?: string; q?: string } = {},
) {
  await authorize({ actor, capability: 'asset.read', resourceless: true });
  return many(
    `SELECT a.*, u.display_name AS assignee_name, v.name AS vendor_name
       FROM assets a
       LEFT JOIN users u ON u.id = a.assigned_to
       LEFT JOIN vendors v ON v.id = a.vendor_id
      WHERE a.company_id = $1
        AND ($2 IS NULL OR a.status = $2)
        AND ($3 IS NULL OR a.assigned_to = $3)
        AND ($4 IS NULL OR a.name LIKE CONCAT('%', $4, '%') OR a.asset_tag LIKE CONCAT('%', $4, '%')
             OR a.serial_number LIKE CONCAT('%', $4, '%'))
      ORDER BY a.asset_tag`,
    [actor.companyId, filters.status ?? null, filters.assignedTo ?? null, filters.q?.trim() || null],
  );
}

export async function createAsset(
  actor: Actor,
  input: {
    assetTag: string;
    name: string;
    category?: string;
    serialNumber?: string | null;
    vendorId?: string | null;
    purchasedOn?: string | null;
    purchaseCost?: number | null;
    currency?: string;
    warrantyUntil?: string | null;
    location?: string | null;
    notes?: string | null;
  },
): Promise<AssetRow> {
  await authorize({ actor, capability: 'asset.manage', resourceless: true });
  const tag = input.assetTag.trim().toUpperCase();
  const existing = await one<{ id: string }>(
    'SELECT id FROM assets WHERE company_id = $1 AND asset_tag = $2',
    [actor.companyId, tag],
  );
  if (existing) throw conflict('That asset tag is already in use');

  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO assets
         (id, company_id, asset_tag, name, category, serial_number, vendor_id,
          purchased_on, purchase_cost, currency, warranty_until, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        actor.companyId,
        tag,
        input.name.trim(),
        input.category ?? 'laptop',
        input.serialNumber?.trim() || null,
        input.vendorId ?? null,
        input.purchasedOn || null,
        input.purchaseCost ?? null,
        input.currency ?? 'USD',
        input.warrantyUntil || null,
        input.location?.trim() || null,
        input.notes?.trim() || null,
      ],
    );
    await auditFromActor(actor, 'asset.create', {
      resourceType: 'asset',
      resourceId: id,
      metadata: { tag, name: input.name },
    }, tx);
    return (await reload<AssetRow>(tx, 'assets', id))!;
  });
}

/**
 * Hands an asset to someone, closing whatever assignment it was on.
 *
 * Assignment is a history rather than a column because the question asked later is never
 * "who has this laptop" but "who had it in March", and because equipment leaving with a
 * departing employee is the commonest way a company loses track of it.
 */
export async function assignAsset(
  actor: Actor,
  assetId: string,
  input: { userId: string | null; conditionNote?: string | null },
): Promise<AssetRow> {
  await authorize({ actor, capability: 'asset.manage', resourceless: true });
  const asset = await one<AssetRow>(
    'SELECT * FROM assets WHERE id = $1 AND company_id = $2',
    [assetId, actor.companyId],
  );
  if (!asset) throw notFound('Asset not found');

  if (input.userId) {
    const holder = await one<{ id: string; status: string }>(
      'SELECT id, status FROM users WHERE id = $1 AND company_id = $2',
      [input.userId, actor.companyId],
    );
    if (!holder) throw notFound('That person was not found');
    if (holder.status !== 'active') {
      throw unprocessable('Equipment cannot be assigned to a closed account', [
        { field: 'userId', message: 'Choose someone active' },
      ]);
    }
  }

  return transaction(async (tx) => {
    await tx.query(
      'UPDATE asset_assignments SET returned_at = NOW(3) WHERE asset_id = $1 AND returned_at IS NULL',
      [assetId],
    );
    if (input.userId) {
      await tx.query(
        `INSERT INTO asset_assignments (id, asset_id, user_id, condition_note, recorded_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId(), assetId, input.userId, input.conditionNote?.trim() || null, actor.userId],
      );
    }
    await tx.query(
      `UPDATE assets SET assigned_to = $2, status = $3, updated_at = NOW(3) WHERE id = $1`,
      [assetId, input.userId, input.userId ? 'assigned' : 'in_stock'],
    );
    await auditFromActor(actor, input.userId ? 'asset.assign' : 'asset.return', {
      resourceType: 'asset',
      resourceId: assetId,
      metadata: { tag: asset.asset_tag, userId: input.userId },
    }, tx);
    return (await reload<AssetRow>(tx, 'assets', assetId))!;
  });
}

export async function assetHistory(actor: Actor, assetId: string) {
  await authorize({ actor, capability: 'asset.read', resourceless: true });
  return many(
    `SELECT a.assigned_at, a.returned_at, a.condition_note,
            u.display_name AS holder_name, r.display_name AS recorded_by_name
       FROM asset_assignments a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users r ON r.id = a.recorded_by
      WHERE a.asset_id = $1
      ORDER BY a.assigned_at DESC`,
    [assetId],
  );
}

/**
 * Equipment still held by someone being offboarded.
 *
 * Offboarding transfers their projects and files, but a laptop is not transferable by a
 * database update - somebody has to physically collect it. Surfacing the list at that
 * moment is the difference between a return and a write-off.
 */
export async function assetsHeldBy(actor: Actor, userId: string) {
  await authorize({ actor, capability: 'asset.read', resourceless: true });
  return many(
    `SELECT id, asset_tag, name, category, serial_number
       FROM assets
      WHERE company_id = $1 AND assigned_to = $2 AND status = 'assigned'
      ORDER BY asset_tag`,
    [actor.companyId, userId],
  );
}
