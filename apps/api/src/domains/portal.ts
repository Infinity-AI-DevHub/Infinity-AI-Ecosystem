/**
 * The client portal: what an external contact sees of their own engagement.
 *
 * Every read here is scoped by the caller's own organisation, resolved from their
 * membership row. Nothing in this module accepts an organisation from the caller, and
 * nothing takes a company-wide listing and filters it afterwards - the organisation is
 * part of the query, so a missing filter is a query that returns nothing rather than a
 * query that returns everybody's.
 *
 * The second rule is that a client sees a document only once it has been sent to them.
 * Drafts and internally-approved-but-unsent invoices are working material; showing a
 * client a figure that has not been agreed internally is worse than showing them nothing.
 * `sent_at IS NOT NULL` is the whole test, and it is applied in SQL rather than in a
 * status list that a new status would silently fall through.
 */
import { many, newId, one, query } from '../core/db.js';
import { forbidden, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { countVisibleFiles } from './files.js';
import { emit } from '../core/outbox.js';

export type PortalOrganisation = {
  id: string;
  name: string;
  contact_name: string | null;
  billing_email: string | null;
};

/**
 * The organisation this guest belongs to.
 *
 * The expiry is re-checked here even though session resolution already refuses an expired
 * guest. This is the module that hands out commercial documents; it does not rely on
 * another layer having got it right.
 */
export async function myOrganisation(actor: Actor): Promise<PortalOrganisation> {
  await authorize({ actor, capability: 'portal.read', resourceless: true });

  const org = await one<PortalOrganisation>(
    `SELECT o.id, o.name, o.contact_name, o.billing_email
       FROM external_memberships m
       JOIN external_organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.company_id = $2
        AND (m.access_expires_at IS NULL OR m.access_expires_at > NOW(3))
        AND o.status = 'active'`,
    [actor.userId, actor.companyId],
  );
  if (!org) throw forbidden('Your access to this workspace has ended');
  return org;
}

/** Money columns arrive from MySQL as strings; a client-facing total must be a number. */
const money = (value: unknown): number => Number(Number(value ?? 0).toFixed(2));

export type PortalInvoice = {
  id: string;
  number: string;
  status: string;
  currency: string;
  issue_date: string;
  due_date: string | null;
  total: number;
  amount_paid: number;
  outstanding: number;
  sent_at: string | null;
  signed_copy_file_id: string | null;
};

/** Their invoices, newest first. Only ones that were actually sent to them. */
export async function listInvoices(actor: Actor): Promise<PortalInvoice[]> {
  const org = await myOrganisation(actor);
  const rows = await many<PortalInvoice>(
    `SELECT i.id, i.number, i.status, i.currency, i.issue_date, i.due_date,
            i.total, i.amount_paid, i.sent_at, i.signed_copy_file_id
       FROM invoices i
      WHERE i.company_id = $1 AND i.client_org_id = $2 AND i.sent_at IS NOT NULL
      ORDER BY i.issue_date DESC, i.number DESC`,
    [actor.companyId, org.id],
  );
  return rows.map((row) => ({
    ...row,
    total: money(row.total),
    amount_paid: money(row.amount_paid),
    outstanding: money(Number(row.total) - Number(row.amount_paid)),
  }));
}

/** One invoice with its lines, provided it is theirs and was sent. */
export async function getInvoice(actor: Actor, invoiceId: string) {
  const org = await myOrganisation(actor);
  const invoice = await one<PortalInvoice & { notes: string | null; terms: string | null }>(
    `SELECT i.id, i.number, i.status, i.currency, i.issue_date, i.due_date,
            i.total, i.amount_paid, i.sent_at, i.signed_copy_file_id, i.notes, i.terms
       FROM invoices i
      WHERE i.id = $1 AND i.company_id = $2 AND i.client_org_id = $3
        AND i.sent_at IS NOT NULL`,
    [invoiceId, actor.companyId, org.id],
  );
  // Not found rather than forbidden: whether an invoice exists for another client is
  // itself something this caller should not learn.
  if (!invoice) throw notFound('Invoice not found');

  // Joined back to the invoice rather than trusting the check above: these read money,
  // and the tenant condition belongs in the query that reads it.
  const lines = await many(
    `SELECT l.description, l.quantity, l.unit_price, l.tax_rate, l.amount
       FROM invoice_lines l
       JOIN invoices i ON i.id = l.invoice_id
      WHERE l.invoice_id = $1 AND i.company_id = $2 AND i.client_org_id = $3
      ORDER BY l.sort_order`,
    [invoiceId, actor.companyId, org.id],
  );
  const payments = await many(
    `SELECT p.amount, p.paid_on, p.method, p.reference
       FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE p.invoice_id = $1 AND i.company_id = $2 AND i.client_org_id = $3
      ORDER BY p.paid_on`,
    [invoiceId, actor.companyId, org.id],
  );

  return {
    ...invoice,
    total: money(invoice.total),
    amount_paid: money(invoice.amount_paid),
    outstanding: money(Number(invoice.total) - Number(invoice.amount_paid)),
    lines,
    payments,
    organisation: org,
  };
}

/** Their quotations. Same rule: sent, or invisible. */
export async function listQuotations(actor: Actor) {
  const org = await myOrganisation(actor);
  const rows = await many<{ total: unknown } & Record<string, unknown>>(
    `SELECT q.id, q.number, q.revision, q.status, q.currency, q.issue_date,
            q.valid_until, q.total, q.summary, q.sent_at, q.signed_copy_file_id
       FROM quotations q
      WHERE q.company_id = $1 AND q.org_id = $2 AND q.sent_at IS NOT NULL
        AND q.status <> 'superseded'
      ORDER BY q.issue_date DESC, q.number DESC`,
    [actor.companyId, org.id],
  );
  return rows.map((row) => ({ ...row, total: money(row.total) }));
}

/** One quotation with its lines. */
export async function getQuotation(actor: Actor, quotationId: string) {
  const org = await myOrganisation(actor);
  const quotation = await one<{ id: string; total: unknown } & Record<string, unknown>>(
    `SELECT q.id, q.number, q.revision, q.status, q.currency, q.issue_date,
            q.valid_until, q.total, q.summary, q.terms, q.sent_at, q.signed_copy_file_id
       FROM quotations q
      WHERE q.id = $1 AND q.company_id = $2 AND q.org_id = $3 AND q.sent_at IS NOT NULL`,
    [quotationId, actor.companyId, org.id],
  );
  if (!quotation) throw notFound('Quotation not found');

  const lines = await many(
    `SELECT l.description, l.quantity, l.unit_price, l.tax_rate, l.amount
       FROM quotation_lines l
       JOIN quotations q ON q.id = l.quotation_id
      WHERE l.quotation_id = $1 AND q.company_id = $2 AND q.org_id = $3
      ORDER BY l.sort_order`,
    [quotationId, actor.companyId, org.id],
  );
  return { ...quotation, total: money(quotation.total), lines, organisation: org };
}

/**
 * The portal's landing figures.
 *
 * Counts only, and only of things already reachable elsewhere in this module, so the
 * summary can never be a way to learn about something the detail views would refuse.
 */
export async function overview(actor: Actor) {
  const org = await myOrganisation(actor);

  const invoices = await one<{ outstanding: unknown; open_count: number; overdue_count: number }>(
    `SELECT COALESCE(SUM(i.total - i.amount_paid), 0) AS outstanding,
            SUM(i.status IN ('open', 'partially_paid'))                       AS open_count,
            SUM(i.status IN ('open', 'partially_paid') AND i.due_date < CURDATE()) AS overdue_count
       FROM invoices i
      WHERE i.company_id = $1 AND i.client_org_id = $2 AND i.sent_at IS NOT NULL
        AND i.status <> 'void'`,
    [actor.companyId, org.id],
  );

  const quotations = await one<{ awaiting: number }>(
    `SELECT COUNT(*) AS awaiting FROM quotations q
      WHERE q.company_id = $1 AND q.org_id = $2 AND q.sent_at IS NOT NULL
        AND q.status = 'sent'`,
    [actor.companyId, org.id],
  );

  /*
   * Counted the way the listings count, not from the grant table.
   *
   * A grant on a folder reaches every file inside it, so counting grant rows reported
   * zero shared files to a client who could open a dozen. The file count therefore comes
   * from the same rule the file listing uses; doc pages and tasks are still granted
   * individually, so those are counted directly.
   */
  const files = await countVisibleFiles(actor);
  const granted = await one<{ tasks: number; pages: number }>(
    `SELECT SUM(g.resource_type = 'task') AS tasks,
            SUM(g.resource_type = 'doc_page') AS pages
       FROM resource_grants g
      WHERE g.company_id = $1 AND g.subject_type = 'user' AND g.subject_id = $2
        AND g.effect = 'allow'
        AND (g.expires_at IS NULL OR g.expires_at > NOW(3))`,
    [actor.companyId, actor.userId],
  );

  return {
    organisation: org,
    invoices: {
      outstanding: money(invoices?.outstanding),
      open: Number(invoices?.open_count ?? 0),
      overdue: Number(invoices?.overdue_count ?? 0),
    },
    quotationsAwaiting: Number(quotations?.awaiting ?? 0),
    shared: {
      files,
      tasks: Number(granted?.tasks ?? 0),
      pages: Number(granted?.pages ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ payments */

/**
 * Every payment we have recorded against their invoices.
 *
 * A client's most common question after "what do I owe" is "did you get my transfer",
 * and the answer was only visible inside one invoice at a time.
 */
export async function listPayments(actor: Actor) {
  const org = await myOrganisation(actor);
  const rows = await many<{ amount: unknown } & Record<string, unknown>>(
    `SELECT p.id, p.amount, p.paid_on, p.method, p.reference, p.receipt_number,
            i.number AS invoice_number, i.currency, i.id AS invoice_id
       FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE i.company_id = $1 AND i.client_org_id = $2 AND i.sent_at IS NOT NULL
      ORDER BY p.paid_on DESC`,
    [actor.companyId, org.id],
  );
  return rows.map((row) => ({ ...row, amount: money(row.amount) }));
}

/**
 * What is due next.
 *
 * The soonest unpaid due date, not a list: the portal shows one date because that is the
 * one a client needs to diary. Anything already past due is reported as overdue rather
 * than as a date in the past, which reads as a mistake.
 */
export async function nextPayment(actor: Actor) {
  const org = await myOrganisation(actor);
  const row = await one<{
    id: string; number: string; due_date: string; currency: string;
    total: unknown; amount_paid: unknown; days_away: number;
  }>(
    `SELECT i.id, i.number, i.due_date, i.currency, i.total, i.amount_paid,
            DATEDIFF(i.due_date, CURDATE()) AS days_away
       FROM invoices i
      WHERE i.company_id = $1 AND i.client_org_id = $2 AND i.sent_at IS NOT NULL
        AND i.status IN ('open', 'partially_paid')
        AND i.due_date IS NOT NULL
      ORDER BY i.due_date
      LIMIT 1`,
    [actor.companyId, org.id],
  );
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    dueDate: row.due_date,
    currency: row.currency,
    amount: money(Number(row.total) - Number(row.amount_paid)),
    daysAway: Number(row.days_away),
    overdue: Number(row.days_away) < 0,
  };
}

/* ------------------------------------------------------------------- notices */

/**
 * Notices addressed to this client's organisation.
 *
 * Matches only the 'organisation' scope, never 'company'. An internal announcement is
 * addressed to the company, and a guest holds a row in that company — so a query that
 * accepted the company scope here would post staff notices to every client.
 */
export async function listNotices(actor: Actor, limit = 30) {
  const org = await myOrganisation(actor);
  return many(
    `SELECT a.id, a.title, a.body, a.priority, a.publish_at
       FROM announcements a
      WHERE a.company_id = $1
        AND a.state = 'published'
        AND a.publish_at <= NOW(3)
        AND (a.expires_at IS NULL OR a.expires_at > NOW(3))
        AND JSON_UNQUOTE(JSON_EXTRACT(a.audience, '$.scope')) = 'organisation'
        AND JSON_CONTAINS(JSON_EXTRACT(a.audience, '$.organisationIds'), JSON_QUOTE($2))
      ORDER BY
        CASE a.priority WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
        a.publish_at DESC
      LIMIT $3`,
    [actor.companyId, org.id, limit],
  );
}

/* --------------------------------------------------------- documents (pages) */

/** Documentation pages shared with this person, which had no listing anywhere. */
export async function listPages(actor: Actor) {
  await myOrganisation(actor);
  return many(
    `SELECT p.id, p.title, p.updated_at
       FROM doc_pages p
       JOIN resource_grants g
         ON g.resource_type = 'doc_page' AND g.resource_id = p.id AND g.effect = 'allow'
      WHERE p.company_id = $1 AND p.state <> 'archived'
        AND g.company_id = $1
        AND (g.expires_at IS NULL OR g.expires_at > NOW(3))
        AND ((g.subject_type = 'user' AND g.subject_id = $2)
          OR (g.subject_type = 'group' AND JSON_CONTAINS($3, JSON_QUOTE(g.subject_id))))
      ORDER BY p.updated_at DESC
      LIMIT 200`,
    [actor.companyId, actor.userId, JSON.stringify(actor.groupIds)],
  );
}

/* ------------------------------------------------------------------- uploads */

export type UploadKind = 'invoice' | 'payment_proof' | 'other';

/**
 * A document the client sends us.
 *
 * The file has already been through the ordinary upload path, so it has been scanned and
 * counted against the quota; this records what it was for. The file must be one this
 * caller uploaded — otherwise a client could attach somebody else's file id to their own
 * submission and have staff open it believing it came from them.
 */
export async function submitUpload(
  actor: Actor,
  input: { fileId: string; kind?: UploadKind; note?: string | null },
) {
  await authorize({ actor, capability: 'portal.upload', resourceless: true });
  const org = await myOrganisation(actor);

  const file = await one<{ id: string; name: string }>(
    `SELECT id, name FROM files
      WHERE id = $1 AND company_id = $2 AND owner_id = $3
        AND state IN ('active', 'processing')`,
    [input.fileId, actor.companyId, actor.userId],
  );
  if (!file) throw notFound('That file could not be found');

  const id = newId();
  await query(
    `INSERT INTO portal_uploads (id, company_id, org_id, file_id, uploaded_by, kind, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, actor.companyId, org.id, file.id, actor.userId, input.kind ?? 'other',
     input.note?.trim() || null],
  );

  await emit({
    companyId: actor.companyId,
    type: 'portal.upload',
    actorId: actor.userId,
    payload: {
      uploadId: id,
      organisationName: org.name,
      uploadedBy: actor.userId,
      fileName: file.name,
      kind: input.kind ?? 'other',
      note: input.note?.trim() || null,
    },
  });

  return { id, fileId: file.id, name: file.name, status: 'received' };
}

/** What this client has sent us, so they can see it arrived. */
export async function listUploads(actor: Actor) {
  const org = await myOrganisation(actor);
  return many(
    `SELECT pu.id, pu.kind, pu.note, pu.status, pu.review_note, pu.created_at,
            f.name, f.mime_type, f.size_bytes, f.id AS file_id
       FROM portal_uploads pu
       JOIN files f ON f.id = pu.file_id
      WHERE pu.company_id = $1 AND pu.org_id = $2
      ORDER BY pu.created_at DESC
      LIMIT 100`,
    [actor.companyId, org.id],
  );
}
