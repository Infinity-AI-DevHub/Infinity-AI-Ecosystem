/**
 * Quotations: what we offered, what they said, and what it became.
 *
 * The lifecycle is the point. A quotation is drafted, signed by two of ours, sent, and
 * then either accepted — which converts the prospect into a client — or declined, which
 * records why. A prospect asking for changes produces a *new revision* rather than an
 * edit, because the old one may already carry signatures and "what did we actually offer
 * in August" has to stay answerable.
 */
import { many, newId, one, pool, reload, transaction, type Queryable } from '../core/db.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { canonicalContent, hashContent, verify } from './signatures.js';

const money = (value: string | number): number => Number(Number(value).toFixed(2));

export type QuotationStatus =
  | 'draft' | 'awaiting_countersign' | 'ready_to_send' | 'sent'
  | 'under_revision' | 'accepted' | 'declined' | 'superseded';

export type LineInput = { description: string; quantity: number; unitPrice: number; taxRate?: number };

function computeTotals(lines: LineInput[]) {
  let subtotal = 0;
  let tax = 0;
  const priced = lines.map((line, index) => {
    const amount = money(line.quantity * line.unitPrice);
    subtotal = money(subtotal + amount);
    tax = money(tax + money((amount * (line.taxRate ?? 0)) / 100));
    return { ...line, amount, sortOrder: index };
  });
  return { priced, subtotal, tax, total: money(subtotal + tax) };
}

function assertLines(lines: LineInput[]): void {
  if (!Array.isArray(lines) || lines.length === 0) throw badRequest('A quotation needs at least one line');
  for (const line of lines) {
    if (!line.description?.trim()) throw badRequest('Every line needs a description');
    if (!(line.quantity > 0)) throw badRequest('Quantity must be greater than zero');
    if (line.unitPrice < 0) throw badRequest('Unit price cannot be negative');
  }
}

async function nextNumber(tx: Queryable, companyId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `QUO-${year}-`;
  const row = (await tx.query<{ last: string | null }>(
    'SELECT MAX(number) AS last FROM quotations WHERE company_id = $1 AND number LIKE $2',
    [companyId, `${prefix}%`],
  )).rows[0];
  const previous = row?.last ? Number(row.last.slice(prefix.length).split('-')[0]) : 0;
  return `${prefix}${String(previous + 1).padStart(4, '0')}`;
}

/** Recomputed and stored whenever content changes, so a read never has to derive it. */
async function refreshHash(tx: Queryable, quotationId: string): Promise<void> {
  const row = (await tx.query<Record<string, unknown>>(
    'SELECT * FROM quotations WHERE id = $1', [quotationId],
  )).rows[0];
  const lines = (await tx.query<never>(
    'SELECT description, quantity, unit_price, tax_rate, amount FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order',
    [quotationId],
  )).rows;
  const hash = hashContent(canonicalContent({ ...row, type: 'quotation' }, lines));
  await tx.query('UPDATE quotations SET content_hash = $2 WHERE id = $1', [quotationId, hash]);
}

export async function createQuotation(
  actor: Actor,
  input: {
    orgId: string;
    issueDate: string;
    validUntil?: string | null;
    currency?: string;
    summary?: string | null;
    terms?: string | null;
    lines: LineInput[];
  },
) {
  await authorize({ actor, capability: 'quotation.manage', resourceless: true });
  assertLines(input.lines);
  const { priced, subtotal, tax, total } = computeTotals(input.lines);

  return transaction(async (tx) => {
    const org = (await tx.query<{ id: string; status: string; name: string }>(
      'SELECT id, status, name FROM external_organizations WHERE id = $1 AND company_id = $2',
      [input.orgId, actor.companyId],
    )).rows[0];
    if (!org) throw notFound('That organisation could not be found');
    if (org.status === 'archived') {
      throw conflict(`${org.name} is archived. Reactivate it before quoting.`);
    }

    const id = newId();
    const number = await nextNumber(tx, actor.companyId);
    await tx.query(
      `INSERT INTO quotations
         (id, company_id, org_id, number, root_id, revision, status, currency,
          issue_date, valid_until, subtotal, tax_amount, total, summary, terms, created_by)
       VALUES ($1,$2,$3,$4,$1,1,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, actor.companyId, input.orgId, number, (input.currency ?? 'LKR').toUpperCase(),
       input.issueDate, input.validUntil ?? null, subtotal, tax, total,
       input.summary ?? null, input.terms ?? null, actor.userId],
    );
    for (const line of priced) {
      await tx.query(
        `INSERT INTO quotation_lines (id, quotation_id, description, quantity, unit_price, tax_rate, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), id, line.description.trim(), line.quantity, line.unitPrice,
         line.taxRate ?? 0, line.amount, line.sortOrder],
      );
    }
    await refreshHash(tx, id);
    await auditFromActor(actor, 'quotation.create',
      { resourceType: 'quotation', resourceId: id, metadata: { number, total } }, tx);
    return (await reload(tx, 'quotations', id))!;
  });
}

/**
 * A revision: the prospect asked for changes.
 *
 * A new row superseding the old one, never an edit. The previous version may already be
 * signed, and a signature that silently comes to cover different numbers is worse than
 * no signature at all. Signatures are deliberately not carried across - the new terms
 * have to be agreed again.
 */
export async function reviseQuotation(
  actor: Actor,
  quotationId: string,
  input: { lines: LineInput[]; summary?: string | null; terms?: string | null; validUntil?: string | null; note: string },
) {
  await authorize({ actor, capability: 'quotation.manage', resourceless: true });
  assertLines(input.lines);
  if (!input.note?.trim()) throw badRequest('Say what changed and why');
  const { priced, subtotal, tax, total } = computeTotals(input.lines);

  return transaction(async (tx) => {
    const previous = (await tx.query<Record<string, unknown>>(
      'SELECT * FROM quotations WHERE id = $1 AND company_id = $2',
      [quotationId, actor.companyId],
    )).rows[0];
    if (!previous) throw notFound('Quotation not found');
    if (previous.status === 'accepted') throw conflict('This quotation has already been accepted');
    if (previous.superseded_by) throw conflict('This quotation has already been revised');

    const id = newId();
    const rootId = String(previous.root_id ?? previous.id);
    const revision = Number(previous.revision) + 1;
    const number = `${String(previous.number).split('-r')[0]}-r${revision}`;

    await tx.query(
      `INSERT INTO quotations
         (id, company_id, org_id, number, root_id, revision, status, currency,
          issue_date, valid_until, subtotal, tax_amount, total, summary, terms, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, actor.companyId, previous.org_id, number, rootId, revision, previous.currency,
       previous.issue_date, input.validUntil ?? previous.valid_until, subtotal, tax, total,
       input.summary ?? previous.summary, input.terms ?? previous.terms, actor.userId],
    );
    for (const line of priced) {
      await tx.query(
        `INSERT INTO quotation_lines (id, quotation_id, description, quantity, unit_price, tax_rate, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), id, line.description.trim(), line.quantity, line.unitPrice,
         line.taxRate ?? 0, line.amount, line.sortOrder],
      );
    }
    await refreshHash(tx, id);
    await tx.query(
      `UPDATE quotations SET status = 'superseded', superseded_by = $2 WHERE id = $1`,
      [quotationId, id],
    );
    await auditFromActor(actor, 'quotation.revise', {
      resourceType: 'quotation', resourceId: id,
      metadata: { supersedes: quotationId, revision, note: input.note },
    }, tx);
    return (await reload(tx, 'quotations', id))!;
  });
}

/** Both internal signatures present: the quotation may go out. */
export async function markReadyToSend(actor: Actor, quotationId: string) {
  await authorize({ actor, capability: 'quotation.manage', resourceless: true });
  const state = await verify(actor, 'quotation', quotationId);
  const internal = state.signatures.filter((s) => s.role.startsWith('internal_'));
  if (internal.length < 2) {
    throw conflict(`This needs two internal signatures; it has ${internal.length}.`);
  }
  if (!state.intact) {
    throw conflict('The quotation changed after it was signed. Revise it and sign again.');
  }
  await pool.query(
    `UPDATE quotations SET status = 'ready_to_send' WHERE id = $1 AND company_id = $2`,
    [quotationId, actor.companyId],
  );
}

export async function sendQuotation(actor: Actor, quotationId: string) {
  await authorize({ actor, capability: 'quotation.manage', resourceless: true });
  return transaction(async (tx) => {
    const quotation = (await tx.query<Record<string, unknown>>(
      'SELECT * FROM quotations WHERE id = $1 AND company_id = $2',
      [quotationId, actor.companyId],
    )).rows[0];
    if (!quotation) throw notFound('Quotation not found');
    if (quotation.status !== 'ready_to_send' && quotation.status !== 'under_revision') {
      throw conflict(`A quotation must be signed by two people before it is sent (it is ${quotation.status})`);
    }
    const org = (await tx.query<{ billing_email: string | null; name: string }>(
      'SELECT billing_email, name FROM external_organizations WHERE id = $1',
      [quotation.org_id],
    )).rows[0];
    if (!org?.billing_email) {
      throw badRequest(`${org?.name ?? 'That organisation'} has no email address to send to.`);
    }

    await tx.query(
      `UPDATE quotations SET status = 'sent', sent_at = NOW(3) WHERE id = $1`, [quotationId],
    );
    await emit({
      companyId: actor.companyId,
      type: 'quotation.sent',
      actorId: actor.userId,
      payload: { quotationId, number: quotation.number },
    }, tx);
    await auditFromActor(actor, 'quotation.send',
      { resourceType: 'quotation', resourceId: quotationId }, tx);
    return (await reload(tx, 'quotations', quotationId))!;
  });
}

/**
 * They said yes: the prospect becomes a client.
 *
 * Conversion is the same record changing status, not a new one - so the quotation that
 * won the work stays attached to the client it created.
 */
export async function acceptQuotation(actor: Actor, quotationId: string) {
  await authorize({ actor, capability: 'quotation.manage', resourceless: true });
  const state = await verify(actor, 'quotation', quotationId);
  if (!state.complete) {
    const missing = state.required.filter((role) => !state.signatures.some((s) => s.role === role));
    throw conflict(`Still unsigned by: ${missing.join(', ')}`);
  }
  if (!state.intact) {
    throw conflict('The quotation changed after it was signed, so it cannot be accepted.');
  }

  return transaction(async (tx) => {
    const quotation = (await tx.query<{ org_id: string; number: string }>(
      'SELECT org_id, number FROM quotations WHERE id = $1 AND company_id = $2',
      [quotationId, actor.companyId],
    )).rows[0];
    if (!quotation) throw notFound('Quotation not found');

    await tx.query(
      `UPDATE quotations SET status = 'accepted', decided_at = NOW(3) WHERE id = $1`,
      [quotationId],
    );
    // The conversion itself.
    await tx.query(
      `UPDATE external_organizations SET status = 'active', kind = 'client' WHERE id = $1`,
      [quotation.org_id],
    );
    await auditFromActor(actor, 'quotation.accepted', {
      resourceType: 'quotation', resourceId: quotationId,
      metadata: { number: quotation.number, convertedOrg: quotation.org_id },
    }, tx);
    return (await reload(tx, 'quotations', quotationId))!;
  });
}

/** They said no. The reason is the most useful thing on a quotation that failed. */
export async function declineQuotation(actor: Actor, quotationId: string, reason: string) {
  await authorize({ actor, capability: 'quotation.manage', resourceless: true });
  if (!reason?.trim()) throw badRequest('Record why it was not converted');
  const result = await pool.query(
    `UPDATE quotations SET status = 'declined', decline_reason = $3, decided_at = NOW(3)
      WHERE id = $1 AND company_id = $2 AND status NOT IN ('accepted','superseded')`,
    [quotationId, actor.companyId, reason.trim()],
  );
  if (result.rowCount === 0) throw conflict('That quotation cannot be declined');
  await auditFromActor(actor, 'quotation.declined', {
    resourceType: 'quotation', resourceId: quotationId, metadata: { reason },
  });
}

export async function listQuotations(actor: Actor, opts: { status?: string; orgId?: string } = {}) {
  await authorize({ actor, capability: 'quotation.read', resourceless: true });
  return many(
    `SELECT q.id, q.number, q.status, q.currency, q.issue_date, q.valid_until, q.total,
            q.revision, q.superseded_by, q.decline_reason, q.sent_at,
            o.name AS org_name, o.status AS org_status,
            (SELECT COUNT(*) FROM document_signatures s
              WHERE s.document_type = 'quotation' AND s.document_id = q.id) AS signature_count
       FROM quotations q
       JOIN external_organizations o ON o.id = q.org_id
      WHERE q.company_id = $1
        AND ($2 IS NULL OR q.status = $2)
        AND ($3 IS NULL OR q.org_id = $3)
      ORDER BY q.created_at DESC
      LIMIT 200`,
    [actor.companyId, opts.status ?? null, opts.orgId ?? null],
  );
}

export async function getQuotation(actor: Actor, quotationId: string) {
  await authorize({ actor, capability: 'quotation.read', resourceless: true });
  const quotation = await one(
    `SELECT q.*, o.name AS org_name, o.status AS org_status, o.billing_email,
            o.representative, o.address_line1, o.address_line2, o.city, o.postal_code,
            o.country, o.tax_registration
       FROM quotations q
       JOIN external_organizations o ON o.id = q.org_id
      WHERE q.id = $1 AND q.company_id = $2`,
    [quotationId, actor.companyId],
  );
  if (!quotation) throw notFound('Quotation not found');
  const lines = await many(
    'SELECT id, description, quantity, unit_price, tax_rate, amount FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order',
    [quotationId],
  );
  const history = await many(
    `SELECT id, number, revision, status, total, created_at
       FROM quotations
      WHERE root_id = COALESCE((SELECT root_id FROM quotations WHERE id = $1), $1)
      ORDER BY revision`,
    [quotationId],
  );
  return { ...quotation, lines, history, signatures: await verify(actor, 'quotation', quotationId) };
}
