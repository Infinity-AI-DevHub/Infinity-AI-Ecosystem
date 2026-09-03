/**
 * How this company's invoices and receipts present themselves.
 *
 * Stored as columns rather than a template language. A company needs its own header,
 * footer, payment instructions and numbering - not the ability to author markup that is
 * later rendered into a document and emailed to a client, which is a script-injection
 * surface pointed at the outside world.
 *
 * The row is created on first read so callers never have to care whether it exists.
 */
import { one, pool } from '../core/db.js';
import { badRequest } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';

export type BillingSettings = {
  company_id: string;
  legal_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  tax_registration: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  payment_instructions: string | null;
  invoice_footer: string | null;
  receipt_footer: string | null;
  default_terms: string | null;
  default_due_days: number;
  invoice_prefix: string;
  receipt_prefix: string;
  accent_colour: string | null;
  logo_file_id: string | null;
};

/** Read, creating the defaults row on first use so no caller has to handle its absence. */
export async function getSettings(actor: Actor): Promise<BillingSettings> {
  await authorize({ actor, capability: 'invoice.read', resourceless: true });
  const existing = await one<BillingSettings>(
    'SELECT * FROM billing_settings WHERE company_id = $1',
    [actor.companyId],
  );
  if (existing) return existing;

  // The company's own name is a better starting point than an empty field.
  await pool.query(
    `INSERT INTO billing_settings (company_id, legal_name)
     SELECT id, COALESCE(legal_name, name) FROM companies WHERE id = $1
     ON DUPLICATE KEY UPDATE company_id = company_id`,
    [actor.companyId],
  );
  return (await one<BillingSettings>(
    'SELECT * FROM billing_settings WHERE company_id = $1',
    [actor.companyId],
  ))!;
}

const PREFIX = /^[A-Z0-9-]{1,12}$/;

export async function updateSettings(
  actor: Actor,
  input: Partial<{
    legalName: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    taxRegistration: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    paymentInstructions: string | null;
    invoiceFooter: string | null;
    receiptFooter: string | null;
    defaultTerms: string | null;
    defaultDueDays: number;
    invoicePrefix: string;
    receiptPrefix: string;
    accentColour: string | null;
    logoFileId: string | null;
  }>,
): Promise<BillingSettings> {
  await authorize({ actor, capability: 'billing.configure', resourceless: true });
  await getSettings(actor);

  if (input.defaultDueDays !== undefined
      && (!Number.isInteger(input.defaultDueDays) || input.defaultDueDays < 0 || input.defaultDueDays > 365)) {
    throw badRequest('Payment terms must be between 0 and 365 days');
  }
  /**
   * Prefixes are constrained because they are part of a reference the client quotes
   * back, and because the next-number query matches on them with LIKE - a prefix
   * containing % or _ would match numbers from a different series.
   */
  for (const [field, value] of [
    ['invoicePrefix', input.invoicePrefix],
    ['receiptPrefix', input.receiptPrefix],
  ] as const) {
    if (value !== undefined && !PREFIX.test(value)) {
      throw badRequest(`${field} must be 1-12 characters, using A-Z, 0-9 or hyphen`);
    }
  }

  await pool.query(
    `UPDATE billing_settings
        SET legal_name = COALESCE($2, legal_name),
            address_line1 = COALESCE($3, address_line1),
            address_line2 = COALESCE($4, address_line2),
            city = COALESCE($5, city),
            postal_code = COALESCE($6, postal_code),
            country = COALESCE($7, country),
            tax_registration = COALESCE($8, tax_registration),
            contact_email = COALESCE($9, contact_email),
            contact_phone = COALESCE($10, contact_phone),
            payment_instructions = COALESCE($11, payment_instructions),
            invoice_footer = COALESCE($12, invoice_footer),
            receipt_footer = COALESCE($13, receipt_footer),
            default_terms = COALESCE($14, default_terms),
            default_due_days = COALESCE($15, default_due_days),
            invoice_prefix = COALESCE($16, invoice_prefix),
            receipt_prefix = COALESCE($17, receipt_prefix),
            accent_colour = COALESCE($18, accent_colour),
            -- Not COALESCE: null here means "remove the logo", which the others have no
            -- equivalent of. The flag separates "not supplied" from "cleared".
            logo_file_id = CASE WHEN $19 THEN $20 ELSE logo_file_id END
      WHERE company_id = $1`,
    [
      actor.companyId,
      input.legalName ?? null, input.addressLine1 ?? null, input.addressLine2 ?? null,
      input.city ?? null, input.postalCode ?? null, input.country ?? null,
      input.taxRegistration ?? null, input.contactEmail?.toLowerCase() ?? null,
      input.contactPhone ?? null, input.paymentInstructions ?? null,
      input.invoiceFooter ?? null, input.receiptFooter ?? null, input.defaultTerms ?? null,
      input.defaultDueDays ?? null, input.invoicePrefix ?? null,
      input.receiptPrefix ?? null, input.accentColour ?? null,
      input.logoFileId !== undefined, input.logoFileId ?? null,
    ],
  );

  await auditFromActor(actor, 'billing.settings_updated', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { changed: Object.keys(input) },
  });
  return getSettings(actor);
}
