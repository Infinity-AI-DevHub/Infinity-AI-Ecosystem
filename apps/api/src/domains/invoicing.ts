/**
 * Invoicing: what a client owes, what they have paid, and what is chasing them.
 *
 * Three rules shape everything here.
 *
 * Totals are computed from the lines on the server and never accepted from the caller.
 * A client that can post its own total can post any total, and an invoice is a claim
 * about money.
 *
 * Payments are append-only. A correction is another row, never an edit, because the
 * payment history of an invoice is the document you produce when a client disputes what
 * they paid and when.
 *
 * "Overdue" is derived, never stored. It is a function of the due date and the balance,
 * so a stored flag would be wrong for the whole window between falling due and some job
 * noticing.
 */
import { many, newId, one, pool, reload, transaction, type Queryable } from '../core/db.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';

/** DECIMAL comes back as a string from the driver; this is the only place it becomes a number. */
const money = (value: string | number): number => Number(Number(value).toFixed(2));

export type InvoiceStatus =
  | 'draft'
  | 'pending_approval'
  | 'open'
  | 'partially_paid'
  | 'paid'
  | 'void';

export type InvoiceRow = {
  id: string;
  company_id: string;
  client_org_id: string;
  project_id: string | null;
  number: string;
  status: InvoiceStatus;
  currency: string;
  issue_date: string;
  due_date: string;
  subtotal: string;
  tax_amount: string;
  total: string;
  amount_paid: string;
  notes: string | null;
  terms: string | null;
  reminders_enabled: number;
  reminder_interval_days: number;
  reminder_last_sent_at: Date | null;
  reminder_count: number;
  sent_at: Date | null;
  version: number;
};

export type LineInput = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate?: number;
};

/**
 * Line arithmetic, in one place.
 *
 * Each line is rounded before being summed rather than after. Summing raw products and
 * rounding once gives a total that does not equal the sum of the lines as printed, and
 * the client adds up the printed lines.
 */
function computeTotals(lines: LineInput[]) {
  let subtotal = 0;
  let tax = 0;
  const priced = lines.map((line, index) => {
    const amount = money(line.quantity * line.unitPrice);
    const lineTax = money((amount * (line.taxRate ?? 0)) / 100);
    subtotal = money(subtotal + amount);
    tax = money(tax + lineTax);
    return { ...line, amount, sortOrder: index };
  });
  return { priced, subtotal, tax, total: money(subtotal + tax) };
}

/**
 * The next reference in a per-company series.
 *
 * Taken inside the caller's transaction against the current maximum, so two people
 * issuing at the same moment cannot both take the same number - the unique index is the
 * backstop, and the retry is the caller's.
 */
async function nextNumber(tx: Queryable, companyId: string, kind: 'invoice' | 'receipt'): Promise<string> {
  const year = new Date().getUTCFullYear();
  // The prefix is configurable per company, and is validated on the way in to a
  // conservative character set - a prefix containing % or _ would make the LIKE below
  // match numbers from an unrelated series.
  const configured = (await tx.query<{ invoice_prefix: string; receipt_prefix: string }>(
    'SELECT invoice_prefix, receipt_prefix FROM billing_settings WHERE company_id = $1',
    [companyId],
  )).rows[0];
  const stem = kind === 'invoice'
    ? configured?.invoice_prefix ?? 'INV'
    : configured?.receipt_prefix ?? 'RCP';
  const prefix = `${stem}-${year}-`;
  const table = kind === 'invoice' ? 'invoices' : 'invoice_payments';
  const column = kind === 'invoice' ? 'number' : 'receipt_number';
  const result = await tx.query<{ last: string | null }>(
    `SELECT MAX(${column}) AS last FROM ${table}
      WHERE company_id = $1 AND ${column} LIKE $2`,
    [companyId, `${prefix}%`],
  );
  const row = result.rows[0];
  const previous = row?.last ? Number(row.last.slice(prefix.length)) : 0;
  return `${prefix}${String(previous + 1).padStart(4, '0')}`;
}

function assertLines(lines: LineInput[]): void {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw badRequest('An invoice needs at least one line');
  }
  for (const line of lines) {
    if (!line.description?.trim()) throw badRequest('Every line needs a description');
    if (!(line.quantity > 0)) throw badRequest('Quantity must be greater than zero');
    if (line.unitPrice < 0) throw badRequest('Unit price cannot be negative');
    if ((line.taxRate ?? 0) < 0 || (line.taxRate ?? 0) > 100) {
      throw badRequest('Tax rate must be between 0 and 100');
    }
  }
}

export async function createInvoice(
  actor: Actor,
  input: {
    clientOrgId: string;
    projectId?: string | null;
    issueDate: string;
    dueDate: string;
    currency?: string;
    lines: LineInput[];
    notes?: string | null;
    terms?: string | null;
    reminderIntervalDays?: number;
    remindersEnabled?: boolean;
  },
): Promise<InvoiceRow> {
  await authorize({ actor, capability: 'invoice.manage', resourceless: true });
  assertLines(input.lines);
  if (new Date(input.dueDate) < new Date(input.issueDate)) {
    throw badRequest('The due date cannot be before the issue date');
  }

  const { priced, subtotal, tax, total } = computeTotals(input.lines);

  return transaction(async (tx) => {
    /**
     * Which clients can be billed.
     *
     * 'upcoming' is allowed: a deposit raised before work starts is the ordinary reason
     * a client is in that state. 'completed' and 'archived' are not - the relationship
     * is over, and a new invoice against it is far more likely a mistake than an
     * intention. Reopening the client is one click and makes the decision visible.
     */
    const client = (await tx.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM external_organizations
        WHERE id = $1 AND company_id = $2`,
      [input.clientOrgId, actor.companyId],
    )).rows[0];
    if (!client) throw notFound('That client could not be found');
    if (client.status !== 'active' && client.status !== 'upcoming') {
      throw conflict(
        `${client.name} is marked ${client.status}. Set it back to active before invoicing it.`,
      );
    }

    if (input.projectId) {
      const project = (await tx.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1 AND company_id = $2',
        [input.projectId, actor.companyId],
      )).rows[0];
      if (!project) throw notFound('That project could not be found');
    }

    const id = newId();
    const number = await nextNumber(tx, actor.companyId, 'invoice');
    await tx.query(
      `INSERT INTO invoices
         (id, company_id, client_org_id, project_id, number, status, currency,
          issue_date, due_date, subtotal, tax_amount, total, notes, terms,
          reminders_enabled, reminder_interval_days, created_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id, actor.companyId, input.clientOrgId, input.projectId ?? null, number,
        (input.currency ?? 'LKR').toUpperCase(), input.issueDate, input.dueDate,
        subtotal, tax, total, input.notes ?? null, input.terms ?? null,
        input.remindersEnabled === false ? 0 : 1,
        input.reminderIntervalDays ?? 7, actor.userId,
      ],
    );

    for (const line of priced) {
      await tx.query(
        `INSERT INTO invoice_lines
           (id, invoice_id, description, quantity, unit_price, tax_rate, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), id, line.description.trim(), line.quantity, line.unitPrice,
         line.taxRate ?? 0, line.amount, line.sortOrder],
      );
    }

    const created = (await reload<InvoiceRow>(tx, 'invoices', id))!;
    await auditFromActor(
      actor, 'invoice.create',
      { resourceType: 'invoice', resourceId: id, metadata: { number, total } },
      tx,
    );
    return created;
  });
}

/**
 * Submit a draft for approval.
 *
 * Anyone who can draft an invoice can send it for release, but releasing it is a
 * separate act reserved to a super administrator. Drafting and approving being the same
 * person is how a wrong number reaches a client with nobody having read it.
 */
export async function submitInvoice(actor: Actor, invoiceId: string): Promise<InvoiceRow> {
  await authorize({ actor, capability: 'invoice.manage', resourceless: true });
  return transaction(async (tx) => {
    const invoice = (await tx.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1 AND company_id = $2',
      [invoiceId, actor.companyId],
    )).rows[0];
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'draft') throw conflict(`This invoice is already ${invoice.status}`);

    await assertClientCanBeEmailed(tx, invoice.client_org_id);

    await tx.query(
      `UPDATE invoices SET status = 'pending_approval', submitted_at = NOW(3),
              version = version + 1
        WHERE id = $1`, [invoiceId],
    );
    await auditFromActor(
      actor, 'invoice.submit',
      { resourceType: 'invoice', resourceId: invoiceId, metadata: { number: invoice.number } }, tx,
    );
    return (await reload<InvoiceRow>(tx, 'invoices', invoiceId))!;
  });
}

/**
 * A client cannot be invoiced by email without an address to invoice.
 *
 * Checked when the invoice is submitted rather than when the mail is dispatched: a
 * failure at dispatch happens in a worker, where the only symptom is an invoice that
 * says "sent" and a client who never received anything.
 */
async function assertClientCanBeEmailed(tx: Queryable, clientOrgId: string): Promise<void> {
  const client = (await tx.query<{ name: string; billing_email: string | null }>(
    'SELECT name, billing_email FROM external_organizations WHERE id = $1',
    [clientOrgId],
  )).rows[0];
  if (!client?.billing_email) {
    throw badRequest(
      `${client?.name ?? 'That client'} has no billing email address, so this invoice ` +
        'cannot be sent. Add one on the client record first.',
    );
  }
}

/**
 * Approve and release: the invoice becomes payable and the client is emailed.
 *
 * The email is emitted through the outbox in the same transaction, so an invoice is
 * never marked sent unless the message was durably queued, and never queued twice.
 */
export async function approveInvoice(actor: Actor, invoiceId: string): Promise<InvoiceRow> {
  await authorize({ actor, capability: 'invoice.approve', resourceless: true });
  return transaction(async (tx) => {
    const invoice = (await tx.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1 AND company_id = $2',
      [invoiceId, actor.companyId],
    )).rows[0];
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'pending_approval' && invoice.status !== 'draft') {
      throw conflict(`This invoice is already ${invoice.status}`);
    }

    await assertClientCanBeEmailed(tx, invoice.client_org_id);

    await tx.query(
      `UPDATE invoices
          SET status = 'open', sent_at = NOW(3), approved_by = $2, approved_at = NOW(3),
              version = version + 1
        WHERE id = $1`,
      [invoiceId, actor.userId],
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'invoice.issued',
        actorId: actor.userId,
        payload: { invoiceId, number: invoice.number },
      },
      tx,
    );
    await auditFromActor(
      actor, 'invoice.approve',
      { resourceType: 'invoice', resourceId: invoiceId, metadata: { number: invoice.number } }, tx,
    );
    return (await reload<InvoiceRow>(tx, 'invoices', invoiceId))!;
  });
}

/** Send it back to the author with a reason, rather than leaving it in limbo. */
export async function rejectInvoice(
  actor: Actor, invoiceId: string, reason: string,
): Promise<InvoiceRow> {
  await authorize({ actor, capability: 'invoice.approve', resourceless: true });
  if (!reason || reason.trim().length < 4) throw badRequest('Say why it is going back');
  return transaction(async (tx) => {
    const invoice = (await tx.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1 AND company_id = $2',
      [invoiceId, actor.companyId],
    )).rows[0];
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'pending_approval') throw conflict('This invoice is not awaiting approval');

    await tx.query(
      `UPDATE invoices SET status = 'draft', submitted_at = NULL, version = version + 1
        WHERE id = $1`, [invoiceId],
    );
    await auditFromActor(
      actor, 'invoice.reject',
      { resourceType: 'invoice', resourceId: invoiceId, metadata: { reason } }, tx,
    );
    return (await reload<InvoiceRow>(tx, 'invoices', invoiceId))!;
  });
}

/**
 * Record a payment, in full or in part.
 *
 * Recording is a different capability from issuing: whoever decides what a client owes
 * should not silently be the person who marks it settled.
 */
export async function recordPayment(
  actor: Actor,
  invoiceId: string,
  input: { amount: number; paidOn: string; method?: string; reference?: string | null; note?: string | null },
): Promise<{ payment: { id: string; receipt_number: string }; invoice: InvoiceRow }> {
  await authorize({ actor, capability: 'payment.record', resourceless: true });
  const amount = money(input.amount);
  if (!(amount > 0)) throw badRequest('A payment must be greater than zero');

  return transaction(async (tx) => {
    // FOR UPDATE: two payments recorded at the same instant must not both read the
    // same amount_paid and each overwrite the other's total.
    const invoice = (await tx.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [invoiceId, actor.companyId],
    )).rows[0];
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status === 'draft' || invoice.status === 'pending_approval') {
      throw conflict('This invoice has not been approved and sent yet');
    }
    if (invoice.status === 'void') throw conflict('This invoice has been voided');

    const balance = money(Number(invoice.total) - Number(invoice.amount_paid));
    if (amount > balance) {
      throw badRequest(
        `That is more than the outstanding balance of ${balance.toFixed(2)} ${invoice.currency}`,
      );
    }

    const paymentId = newId();
    const receiptNumber = await nextNumber(tx, actor.companyId, 'receipt');
    await tx.query(
      `INSERT INTO invoice_payments
         (id, company_id, invoice_id, amount, paid_on, method, reference, note,
          receipt_number, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [paymentId, actor.companyId, invoiceId, amount, input.paidOn,
       input.method ?? 'bank_transfer', input.reference ?? null, input.note ?? null,
       receiptNumber, actor.userId],
    );

    const paid = money(Number(invoice.amount_paid) + amount);
    // Settled is decided here rather than by comparing floats at read time.
    const status: InvoiceStatus = paid >= Number(invoice.total) ? 'paid' : 'partially_paid';
    await tx.query(
      `UPDATE invoices
          SET amount_paid = $1, status = $2, version = version + 1,
              -- A paid invoice must stop being chased, immediately and without
              -- depending on the reminder job to notice.
              reminder_last_sent_at = CASE WHEN $2 = 'paid' THEN NULL ELSE reminder_last_sent_at END
        WHERE id = $3`,
      [paid, status, invoiceId],
    );

    await emit(
      {
        companyId: actor.companyId,
        type: 'invoice.payment_recorded',
        actorId: actor.userId,
        payload: { invoiceId, paymentId, receiptNumber, amount, fullySettled: status === 'paid' },
      },
      tx,
    );
    await auditFromActor(
      actor, 'invoice.payment',
      { resourceType: 'invoice', resourceId: invoiceId, metadata: { amount, receiptNumber, status } },
      tx,
    );

    return {
      payment: { id: paymentId, receipt_number: receiptNumber },
      invoice: (await reload<InvoiceRow>(tx, 'invoices', invoiceId))!,
    };
  });
}

export async function voidInvoice(actor: Actor, invoiceId: string, reason: string): Promise<void> {
  await authorize({ actor, capability: 'invoice.manage', resourceless: true });
  if (!reason || reason.trim().length < 4) throw badRequest('Give a reason for voiding this invoice');
  await transaction(async (tx) => {
    const invoice = (await tx.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1 AND company_id = $2', [invoiceId, actor.companyId],
    )).rows[0];
    if (!invoice) throw notFound('Invoice not found');
    if (Number(invoice.amount_paid) > 0) {
      throw conflict('This invoice has payments against it and cannot be voided');
    }
    await tx.query(
      `UPDATE invoices SET status = 'void', reminders_enabled = 0, version = version + 1
        WHERE id = $1`, [invoiceId],
    );
    await auditFromActor(
      actor, 'invoice.void',
      { resourceType: 'invoice', resourceId: invoiceId, metadata: { reason } }, tx,
    );
  });
}

/** Reminder cadence, per invoice, so a difficult client can be chased differently. */
export async function setReminderPolicy(
  actor: Actor,
  invoiceId: string,
  input: { enabled: boolean; intervalDays: number },
): Promise<void> {
  await authorize({ actor, capability: 'invoice.manage', resourceless: true });
  if (!Number.isInteger(input.intervalDays) || input.intervalDays < 1 || input.intervalDays > 90) {
    throw badRequest('Reminder interval must be between 1 and 90 days');
  }
  const result = await pool.query(
    `UPDATE invoices SET reminders_enabled = $1, reminder_interval_days = $2
      WHERE id = $3 AND company_id = $4`,
    [input.enabled ? 1 : 0, input.intervalDays, invoiceId, actor.companyId],
  );
  if (result.rowCount === 0) throw notFound('Invoice not found');
  await auditFromActor(actor, 'invoice.reminder_policy', {
    resourceType: 'invoice', resourceId: invoiceId, metadata: input,
  });
}

/**
 * The bucket an invoice is in, as a SQL predicate.
 *
 * Overdue overlaps open and partially_paid rather than replacing them, because an
 * invoice does not stop being partly paid by becoming late.
 */
const BUCKETS: Record<string, string> = {
  draft: "i.status = 'draft'",
  pending_approval: "i.status = 'pending_approval'",
  open: "i.status = 'open'",
  partially_paid: "i.status = 'partially_paid'",
  paid: "i.status = 'paid'",
  void: "i.status = 'void'",
  overdue: "i.status IN ('open','partially_paid') AND i.due_date < CURDATE() AND (i.total - i.amount_paid) > 0",
  outstanding: "i.status IN ('open','partially_paid')",
  all: 'TRUE',
};

export async function listInvoices(
  actor: Actor,
  opts: { bucket?: string; clientOrgId?: string; projectId?: string; limit?: number } = {},
) {
  await authorize({ actor, capability: 'invoice.read', resourceless: true });
  const predicate = BUCKETS[opts.bucket ?? 'all'] ?? BUCKETS.all;
  return many(
    `SELECT i.id, i.number, i.status, i.currency, i.issue_date, i.due_date,
            i.subtotal, i.tax_amount, i.total, i.amount_paid,
            (i.total - i.amount_paid) AS balance,
            i.reminders_enabled, i.reminder_interval_days, i.reminder_count,
            i.reminder_last_sent_at, i.sent_at,
            -- Derived, not stored: correct the instant the date rolls over.
            (i.status IN ('open','partially_paid')
             AND i.due_date < CURDATE()
             AND (i.total - i.amount_paid) > 0) AS is_overdue,
            DATEDIFF(CURDATE(), i.due_date) AS days_late,
            o.name AS client_name, p.name AS project_name
       FROM invoices i
       JOIN external_organizations o ON o.id = i.client_org_id
       LEFT JOIN projects p ON p.id = i.project_id
      WHERE i.company_id = $1
        AND ($2 IS NULL OR i.client_org_id = $2)
        AND ($3 IS NULL OR i.project_id = $3)
        AND (${predicate})
      ORDER BY i.issue_date DESC, i.number DESC
      LIMIT $4`,
    [actor.companyId, opts.clientOrgId ?? null, opts.projectId ?? null, opts.limit ?? 100],
  );
}

export async function getInvoice(actor: Actor, invoiceId: string) {
  await authorize({ actor, capability: 'invoice.read', resourceless: true });
  const invoice = await one(
    `SELECT i.*, (i.total - i.amount_paid) AS balance,
            o.name AS client_name, p.name AS project_name,
            -- Carried on the invoice so the screen and the emailed document address
            -- the client the same way.
            o.billing_email, o.representative, o.contact_name, o.contact_phone,
            o.address_line1, o.address_line2, o.city, o.postal_code, o.country,
            o.tax_registration
       FROM invoices i
       JOIN external_organizations o ON o.id = i.client_org_id
       LEFT JOIN projects p ON p.id = i.project_id
      WHERE i.id = $1 AND i.company_id = $2`,
    [invoiceId, actor.companyId],
  );
  if (!invoice) throw notFound('Invoice not found');
  const lines = await many(
    `SELECT id, description, quantity, unit_price, tax_rate, amount
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`, [invoiceId],
  );
  const payments = await many(
    `SELECT p.id, p.amount, p.paid_on, p.method, p.reference, p.note,
            p.receipt_number, p.receipt_sent_at, u.display_name AS recorded_by_name
       FROM invoice_payments p
       LEFT JOIN users u ON u.id = p.recorded_by
      WHERE p.invoice_id = $1 ORDER BY p.paid_on, p.created_at`, [invoiceId],
  );
  return { ...invoice, lines, payments };
}

/** The dashboard figures: what is owed, what is late, what is still a draft. */
export async function summary(actor: Actor) {
  await authorize({ actor, capability: 'invoice.read', resourceless: true });
  const row = await one(
    `SELECT
       COUNT(*) AS total_count,
       COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END),0) AS draft_count,
       COALESCE(SUM(CASE WHEN status IN ('open','partially_paid')
                    THEN total - amount_paid ELSE 0 END),0) AS outstanding_amount,
       COALESCE(SUM(CASE WHEN status IN ('open','partially_paid')
                          AND due_date < CURDATE() AND (total - amount_paid) > 0
                    THEN total - amount_paid ELSE 0 END),0) AS overdue_amount,
       COALESCE(SUM(CASE WHEN status IN ('open','partially_paid')
                          AND due_date < CURDATE() AND (total - amount_paid) > 0
                    THEN 1 ELSE 0 END),0) AS overdue_count,
       COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END),0) AS paid_amount
     FROM invoices WHERE company_id = $1`,
    [actor.companyId],
  );
  return row ?? {};
}
