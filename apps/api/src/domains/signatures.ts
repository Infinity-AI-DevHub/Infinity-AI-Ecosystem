/**
 * Document signatures, and what makes them worth anything.
 *
 * The image is not the signature. Anyone can paste a PNG onto a page, and a system that
 * treated the picture as proof would be theatre.
 *
 * What this records is: which authenticated account placed it, at what time, from what
 * address, and - the part that matters - a SHA-256 of exactly what the document said at
 * that moment. Verification recomputes that hash from the document as it stands now. If
 * a line, a total or a term changed after signing, the hashes diverge and every affected
 * signature is reported as broken rather than quietly continuing to look valid.
 *
 * That is a detection guarantee, not a cryptographic identity one: it proves the document
 * was altered after signing, and it proves which account acted. It is not a qualified
 * electronic signature and does not claim to be.
 */
import { createHash } from 'node:crypto';
import { many, newId, one, pool, type Queryable } from '../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { authorize, capabilitiesForRole, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { downloadUrl } from './files.js';

export type DocumentType = 'quotation' | 'invoice' | 'receipt';
export type SignatureRole = 'internal_1' | 'internal_2' | 'client_1' | 'client_2';

/**
 * How many signatures each document needs, and from whom.
 *
 * A receipt takes four because both sides acknowledge that money moved; a quotation and
 * an invoice take three, because only one side is committing to the amount.
 */
export const REQUIRED_ROLES: Record<DocumentType, SignatureRole[]> = {
  quotation: ['internal_1', 'internal_2', 'client_1'],
  invoice: ['internal_1', 'internal_2', 'client_1'],
  receipt: ['internal_1', 'internal_2', 'client_1', 'client_2'],
};

const INTERNAL_ROLES: SignatureRole[] = ['internal_1', 'internal_2'];

export type SignatureRow = {
  id: string;
  role: SignatureRole;
  signer_user_id: string | null;
  signer_name: string;
  signer_email: string | null;
  image_file_id: string | null;
  page: number;
  pos_x: string | null;
  pos_y: string | null;
  width: string | null;
  signed_hash: string;
  signed_at: Date;
};

/**
 * The canonical form of a document, for hashing.
 *
 * Only the parts a signer is agreeing to: the parties, the money, the dates and the
 * terms. Deliberately not the whole row - `updated_at` moving, or somebody correcting a
 * typo in an internal note, must not invalidate a signature that was about the amount.
 *
 * Field order is fixed rather than taken from object iteration, because a hash whose
 * input order can drift is a hash that fails for the wrong reason.
 */
export function canonicalContent(
  header: Record<string, unknown>,
  lines: { description: string; quantity: unknown; unit_price: unknown; tax_rate: unknown; amount: unknown }[],
): string {
  const money = (value: unknown) => Number(value ?? 0).toFixed(2);
  const parts = [
    `type:${header.type ?? ''}`,
    `number:${header.number ?? ''}`,
    `org:${header.org_id ?? ''}`,
    `currency:${header.currency ?? ''}`,
    `issue:${String(header.issue_date ?? '').slice(0, 10)}`,
    `due:${String(header.due_date ?? header.valid_until ?? '').slice(0, 10)}`,
    `subtotal:${money(header.subtotal)}`,
    `tax:${money(header.tax_amount)}`,
    `total:${money(header.total)}`,
    `terms:${String(header.terms ?? '').trim()}`,
  ];
  for (const [index, line] of lines.entries()) {
    parts.push(
      `line${index}:${line.description.trim()}|${Number(line.quantity)}|`
        + `${money(line.unit_price)}|${Number(line.tax_rate)}|${money(line.amount)}`,
    );
  }
  return parts.join('\n');
}

export function hashContent(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Resolves a document across the three tables, scoped to the actor's company. */
async function loadDocument(
  actor: Actor,
  type: DocumentType,
  documentId: string,
  db: Queryable = pool,
): Promise<{ hash: string; label: string; orgId: string | null }> {
  if (type === 'quotation') {
    const row = (await db.query<Record<string, unknown>>(
      'SELECT * FROM quotations WHERE id = $1 AND company_id = $2',
      [documentId, actor.companyId],
    )).rows[0];
    if (!row) throw notFound('Quotation not found');
    const lines = (await db.query<never>(
      'SELECT description, quantity, unit_price, tax_rate, amount FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order',
      [documentId],
    )).rows;
    return {
      hash: hashContent(canonicalContent({ ...row, type }, lines)),
      label: String(row.number),
      orgId: String(row.org_id),
    };
  }

  if (type === 'invoice') {
    const row = (await db.query<Record<string, unknown>>(
      'SELECT * FROM invoices WHERE id = $1 AND company_id = $2',
      [documentId, actor.companyId],
    )).rows[0];
    if (!row) throw notFound('Invoice not found');
    const lines = (await db.query<never>(
      'SELECT description, quantity, unit_price, tax_rate, amount FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
      [documentId],
    )).rows;
    return {
      hash: hashContent(canonicalContent({ ...row, type, org_id: row.client_org_id }, lines)),
      label: String(row.number),
      orgId: String(row.client_org_id),
    };
  }

  // A receipt is a payment: its content is the amount, the date and the invoice it
  // settles, so those are what a signature is about.
  const row = (await db.query<Record<string, unknown>>(
    `SELECT p.*, i.number AS invoice_number, i.currency, i.client_org_id
       FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.id = $1 AND p.company_id = $2`,
    [documentId, actor.companyId],
  )).rows[0];
  if (!row) throw notFound('Receipt not found');
  return {
    hash: hashContent(
      canonicalContent(
        {
          type,
          number: row.receipt_number,
          org_id: row.client_org_id,
          currency: row.currency,
          issue_date: row.paid_on,
          total: row.amount,
          terms: `invoice:${row.invoice_number}|method:${row.method}|ref:${row.reference ?? ''}`,
        },
        [],
      ),
    ),
    label: String(row.receipt_number ?? 'receipt'),
    orgId: String(row.client_org_id),
  };
}

/** The signature image this person has saved, if any. */
export async function mySignature(actor: Actor) {
  return one<{ file_id: string; updated_at: Date }>(
    'SELECT file_id, updated_at FROM user_signatures WHERE user_id = $1',
    [actor.userId],
  );
}

/**
 * Saving a signature image, so it is uploaded once rather than every time.
 *
 * Stored per account and never shared: one person's signature must not be placeable by
 * another, which is the whole basis of the record being meaningful.
 */
export async function saveMySignature(actor: Actor, fileId: string) {
  const file = await one<{ id: string; mime_type: string; owner_id: string | null }>(
    'SELECT id, mime_type, owner_id FROM files WHERE id = $1 AND company_id = $2',
    [fileId, actor.companyId],
  );
  if (!file) throw notFound('That image could not be found');
  if (!/^image\/(png|jpeg|svg\+xml)$/.test(file.mime_type)) {
    throw badRequest('A signature must be a PNG, JPEG or SVG image');
  }
  if (file.owner_id && file.owner_id !== actor.userId) {
    // Uploading someone else's file as your own signature would let one person sign in
    // another's name with a picture that looks right.
    throw forbidden('You can only save a signature you uploaded yourself');
  }

  await pool.query(
    `INSERT INTO user_signatures (user_id, file_id) VALUES ($1,$2)
     ON DUPLICATE KEY UPDATE file_id = VALUES(file_id)`,
    [actor.userId, fileId],
  );
  await auditFromActor(actor, 'signature.saved', {
    resourceType: 'user', resourceId: actor.userId,
  });
}

/**
 * Placing a signature on a document.
 *
 * The hash is computed here, from the database, at the moment of signing - never taken
 * from the caller. A client that supplied its own hash could sign one document and
 * record having signed another.
 */
export async function signDocument(
  actor: Actor,
  input: {
    documentType: DocumentType;
    documentId: string;
    role: SignatureRole;
    page?: number;
    posX?: number;
    posY?: number;
    width?: number;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<SignatureRow> {
  await authorize({ actor, capability: 'document.sign', resourceless: true });

  if (!INTERNAL_ROLES.includes(input.role)) {
    throw badRequest(
      'Client signatures are recorded by uploading the copy they returned, not placed here.',
    );
  }
  if (!REQUIRED_ROLES[input.documentType].includes(input.role)) {
    throw badRequest(`A ${input.documentType} has no ${input.role} signature`);
  }

  const document = await loadDocument(actor, input.documentType, input.documentId);

  const saved = await mySignature(actor);
  if (!saved) {
    throw badRequest('Save a signature image in your settings before signing.');
  }

  const existing = await one<{ signer_name: string }>(
    `SELECT signer_name FROM document_signatures
      WHERE document_type = $1 AND document_id = $2 AND role = $3`,
    [input.documentType, input.documentId, input.role],
  );
  if (existing) throw conflict(`That slot is already signed by ${existing.signer_name}`);

  /**
   * The two internal signatures must be two different people.
   *
   * The whole reason for a countersignature is a second pair of eyes; letting one
   * account fill both slots would make it a formality.
   */
  const mine = await one<{ role: string }>(
    `SELECT role FROM document_signatures
      WHERE document_type = $1 AND document_id = $2 AND signer_user_id = $3`,
    [input.documentType, input.documentId, actor.userId],
  );
  if (mine) throw conflict('You have already signed this document');

  const id = newId();
  await pool.query(
    `INSERT INTO document_signatures
       (id, company_id, document_type, document_id, role, signer_user_id, signer_name,
        signer_email, image_file_id, page, pos_x, pos_y, width, signed_hash,
        signed_ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id, actor.companyId, input.documentType, input.documentId, input.role,
      actor.userId, actor.displayName, actor.email, saved.file_id,
      input.page ?? 1, input.posX ?? null, input.posY ?? null, input.width ?? null,
      document.hash, input.ip ?? null, (input.userAgent ?? '').slice(0, 300) || null,
    ],
  );

  await auditFromActor(actor, 'document.signed', {
    resourceType: input.documentType,
    resourceId: input.documentId,
    metadata: { role: input.role, label: document.label, hash: document.hash },
  });

  return (await one<SignatureRow>('SELECT * FROM document_signatures WHERE id = $1', [id]))!;
}

/**
 * Recording the client's signature from the copy they returned.
 *
 * Their signature happens outside this system, so what is recorded is the fact of
 * receipt and the file itself - honestly labelled as counter-signed offline rather than
 * dressed up as an in-app signature it never was.
 */
export async function recordClientSignature(
  actor: Actor,
  input: {
    documentType: DocumentType;
    documentId: string;
    role: 'client_1' | 'client_2';
    signerName: string;
    signerEmail?: string | null;
    fileId: string;
  },
) {
  await authorize({ actor, capability: 'document.sign', resourceless: true });
  if (!REQUIRED_ROLES[input.documentType].includes(input.role)) {
    throw badRequest(`A ${input.documentType} has no ${input.role} signature`);
  }
  const document = await loadDocument(actor, input.documentType, input.documentId);

  const internal = await many<{ role: string }>(
    `SELECT role FROM document_signatures
      WHERE document_type = $1 AND document_id = $2 AND role IN ('internal_1','internal_2')`,
    [input.documentType, input.documentId],
  );
  if (internal.length < 2) {
    throw conflict('Both internal signatures are needed before the client countersigns');
  }

  const file = await one('SELECT id FROM files WHERE id = $1 AND company_id = $2', [
    input.fileId, actor.companyId,
  ]);
  if (!file) throw notFound('That file could not be found');

  const id = newId();
  await pool.query(
    `INSERT INTO document_signatures
       (id, company_id, document_type, document_id, role, signer_name, signer_email,
        image_file_id, signed_hash, signed_ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL)`,
    [id, actor.companyId, input.documentType, input.documentId, input.role,
     input.signerName.trim(), input.signerEmail?.trim().toLowerCase() ?? null,
     input.fileId, document.hash],
  );
  await auditFromActor(actor, 'document.client_signature_recorded', {
    resourceType: input.documentType,
    resourceId: input.documentId,
    metadata: { role: input.role, signer: input.signerName, recordedBy: actor.userId },
  });
}

/**
 * Asking a colleague to countersign.
 *
 * The request is the point: without it the second signatory has to know, unprompted,
 * that something is waiting for them — which in practice means being chased in person,
 * exactly what a workflow is supposed to remove.
 *
 * Emitted through the outbox so the notification and the email are queued in the same
 * transaction as the request itself. A request that is recorded but never delivered is
 * worse than no request, because the asker believes it went.
 */
export async function requestCountersignature(
  actor: Actor,
  input: { documentType: DocumentType; documentId: string; signerUserId: string; note?: string | null },
): Promise<void> {
  await authorize({ actor, capability: 'document.sign', resourceless: true });

  if (input.signerUserId === actor.userId) {
    throw badRequest('The second signature has to come from somebody else');
  }

  const document = await loadDocument(actor, input.documentType, input.documentId);

  const signer = await one<{
    id: string; display_name: string; email_display: string; access_level: string;
  }>(
    `SELECT id, display_name, email_display, access_level FROM users
      WHERE id = $1 AND company_id = $2 AND status = 'active'`,
    [input.signerUserId, actor.companyId],
  );
  if (!signer) throw notFound('That person could not be found');

  /*
   * They have to be able to sign it.
   *
   * Signing is limited to administrators, and nothing here checked that - so a request
   * could be sent to somebody who would be refused the moment they opened it, after
   * being notified and emailed about a document they cannot action.
   */
  const signerCapabilities = await capabilitiesForRole(signer.access_level);
  if (!signerCapabilities.has('document.sign')) {
    throw badRequest(`${signer.display_name} is not permitted to sign documents`);
  }

  const existing = await many<{ role: string; signer_user_id: string | null }>(
    `SELECT role, signer_user_id FROM document_signatures
      WHERE document_type = $1 AND document_id = $2`,
    [input.documentType, input.documentId],
  );
  if (existing.some((row) => row.signer_user_id === input.signerUserId)) {
    throw conflict(`${signer.display_name} has already signed this`);
  }
  const internal = existing.filter((row) => row.role.startsWith('internal_'));
  if (internal.length === 0) {
    // Asking for a countersignature before signing yourself inverts the point of it.
    throw conflict('Sign it yourself before asking somebody to countersign');
  }
  if (internal.length >= 2) throw conflict('Both internal signatures are already in place');

  await emit({
    companyId: actor.companyId,
    type: 'signature.requested',
    actorId: actor.userId,
    payload: {
      documentType: input.documentType,
      documentId: input.documentId,
      documentLabel: document.label,
      signerUserId: signer.id,
      signerName: signer.display_name,
      signerEmail: signer.email_display,
      requestedBy: actor.displayName,
      note: input.note ?? null,
    },
  });

  await auditFromActor(actor, 'signature.requested', {
    resourceType: input.documentType,
    resourceId: input.documentId,
    metadata: { signerUserId: signer.id, label: document.label },
  });
}

export type Verification = {
  documentHash: string;
  required: SignatureRole[];
  signatures: (SignatureRow & { valid: boolean; imageUrl: string | null })[];
  complete: boolean;
  /** True when every signature was made against the document as it stands now. */
  intact: boolean;
};

/**
 * Does this document still match what people signed?
 *
 * Recomputed on every read rather than cached, because a cached answer is exactly what
 * an alteration would want to leave in place.
 */
export async function verify(
  actor: Actor,
  documentType: DocumentType,
  documentId: string,
): Promise<Verification> {
  const document = await loadDocument(actor, documentType, documentId);
  const rows = await many<SignatureRow>(
    `SELECT * FROM document_signatures
      WHERE document_type = $1 AND document_id = $2 AND company_id = $3
      ORDER BY signed_at`,
    [documentType, documentId, actor.companyId],
  );
  const required = REQUIRED_ROLES[documentType];
  // The row only knows which file holds the signature image. Every reader of this -
  // the quotation, invoice and receipt previews alike - needs something it can put in
  // an <img>, so resolve it once here rather than leaving each caller to remember.
  const signatures = await Promise.all(rows.map(async (row) => {
    const base = { ...row, valid: row.signed_hash === document.hash };
    if (!row.image_file_id) return { ...base, imageUrl: null };
    try {
      const link = await downloadUrl(actor, row.image_file_id);
      return { ...base, imageUrl: link.url };
    } catch {
      // An unreadable image must not take the whole document down with it: the name
      // and date still say who signed and when.
      return { ...base, imageUrl: null };
    }
  }));
  return {
    documentHash: document.hash,
    required,
    signatures,
    complete: required.every((role) => rows.some((row) => row.role === role)),
    intact: signatures.every((signature) => signature.valid),
  };
}
