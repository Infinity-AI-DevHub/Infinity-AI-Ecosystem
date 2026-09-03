/**
 * Rendering an invoice, quotation or receipt — as a PDF to attach, and as the HTML body
 * of the email that carries it.
 *
 * Both come from the same data in one place, so the email and the attachment cannot
 * disagree about what is owed. Everything company-specific comes from billing settings:
 * a letterhead is configuration, not a code change.
 */
import { A4, PdfDocument, type Colour } from '../core/pdf.js';
import { many, one } from '../core/db.js';
import { decodePng } from '../core/png.js';
import { readStream } from './files.js';

export type DocumentKind = 'invoice' | 'quotation' | 'receipt';

type Profile = {
  legal_name: string | null; address_line1: string | null; address_line2: string | null;
  city: string | null; postal_code: string | null; country: string | null;
  tax_registration: string | null; contact_email: string | null; contact_phone: string | null;
  payment_instructions: string | null; invoice_footer: string | null;
  receipt_footer: string | null; accent_colour: string | null;
  logo_file_id?: string | null;
  /** Decoded once by billingProfile, because the renderer is synchronous. */
  logo?: { width: number; height: number; rgb: Buffer; alpha: Buffer | null } | null;
};

export type RenderModel = {
  kind: DocumentKind;
  number: string;
  currency: string;
  issueDate: string;
  dueLabel: string | null;
  dueDate: string | null;
  partyName: string;
  partyLines: string[];
  projectName: string | null;
  summary: string | null;
  lines: { description: string; quantity: number; unitPrice: number; taxRate: number; amount: number }[];
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  /** A receipt states what was received rather than what is owed. */
  receivedAmount: number | null;
  method: string | null;
  reference: string | null;
  terms: string | null;
  /** Drawn on the page whether filled or not: an empty slot is information. */
  signatures?: SignatureSlot[];
};

export type SignatureSlot = {
  role: string;
  label: string;
  signerName: string | null;
  signedOn: string | null;
  /** Decoded PNG, when the signer has an image and it could be read. */
  image: { width: number; height: number; rgb: Buffer; alpha: Buffer | null } | null;
  /** False when the document changed after this was signed. */
  valid: boolean;
};

const MARGIN = 48;
const RIGHT = A4.width - MARGIN;

function hexToRgb(hex: string | null): Colour {
  const value = (hex ?? '#1A6288').replace('#', '');
  const int = Number.parseInt(value.length === 3
    ? value.split('').map((c) => c + c).join('') : value, 16);
  if (Number.isNaN(int)) return [0.10, 0.38, 0.53];
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}


/**
 * A date, as a person would write it.
 *
 * The driver hands DATE columns back as JS Date objects, so String(value).slice(0, 10)
 * yields "Tue Sep 01" — the first ten characters of a JS date string, not an ISO date.
 * That was reaching clients on real invoices.
 */
function formatDate(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

// Grouped digits without the currency code, for the columns where the code is already
// stated once in the totals. A line reading 450000.00 beside a total reading
// LKR 450,000.00 looks like two different numbers.
const amount = (value: number) =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const money = (value: number, currency: string) => `${currency} ${amount(value)}`;

const TITLE: Record<DocumentKind, string> = {
  invoice: 'INVOICE', quotation: 'QUOTATION', receipt: 'RECEIPT',
};

const PARTY_LABEL: Record<DocumentKind, string> = {
  invoice: 'BILLED TO', quotation: 'PREPARED FOR', receipt: 'RECEIVED FROM',
};

export function renderPdf(model: RenderModel, profile: Profile): Buffer {
  const doc = new PdfDocument();
  const accent = hexToRgb(profile.accent_colour);
  const muted: Colour = [0.48, 0.53, 0.58];
  const ink: Colour = [0.10, 0.14, 0.19];

  // ---- letterhead ----------------------------------------------------------
  /*
   * The logo sits above the document title rather than beside it. Beside it, a wide
   * logo and a long legal name collide in the middle of the page; stacked, both have
   * the full column width and the title still reads as the first thing on the page.
   * Height is capped and the width follows the aspect ratio, so a square mark and a
   * long wordmark both land sensibly without anybody configuring anything.
   */
  let titleTop = MARGIN + 14;
  if (profile.logo) {
    const cap = 30;
    const logoH = Math.min(cap, profile.logo.height);
    const logoW = (profile.logo.width / profile.logo.height) * logoH;
    doc.image(MARGIN, MARGIN - 4, profile.logo, Math.min(logoW, 180));
    titleTop = MARGIN + logoH + 22;
  }

  doc.text(MARGIN, titleTop, TITLE[model.kind], { size: 22, font: 'bold', colour: accent });
  doc.text(MARGIN, titleTop + 18, model.number, { size: 11, font: 'bold', colour: ink });

  let headRight = MARGIN + 8;
  doc.textRight(RIGHT, headRight, profile.legal_name ?? '', { size: 10, font: 'bold', colour: ink });
  headRight += 13;
  for (const line of [
    profile.address_line1, profile.address_line2,
    [profile.city, profile.postal_code].filter(Boolean).join(' ') || null,
    profile.country,
    profile.tax_registration ? `Tax reg. ${profile.tax_registration}` : null,
    profile.contact_email, profile.contact_phone,
  ].filter((v): v is string => Boolean(v && String(v).trim()))) {
    doc.textRight(RIGHT, headRight, line, { size: 8.5, colour: muted });
    headRight += 11;
  }

  // A rule in the company colour, which is most of what makes a page look like a
  // document rather than a printout.
  const ruleTop = Math.max(headRight + 6, titleTop + 30);
  doc.rect(MARGIN, ruleTop, RIGHT - MARGIN, 2.2, accent);

  // ---- parties -------------------------------------------------------------
  let left = ruleTop + 22;
  doc.text(MARGIN, left, PARTY_LABEL[model.kind], { size: 7.5, font: 'bold', colour: muted });
  left += 13;
  doc.text(MARGIN, left, model.partyName, { size: 11, font: 'bold', colour: ink });
  left += 13;
  for (const line of model.partyLines) {
    doc.text(MARGIN, left, line, { size: 9, colour: muted });
    left += 11;
  }

  let right = ruleTop + 22;
  const meta: [string, string][] = [['ISSUED', model.issueDate]];
  if (model.dueLabel && model.dueDate) meta.push([model.dueLabel, model.dueDate]);
  if (model.projectName) meta.push(['PROJECT', model.projectName]);
  if (model.method) meta.push(['METHOD', model.method.replace('_', ' ')]);
  if (model.reference) meta.push(['REFERENCE', model.reference]);
  for (const [label, value] of meta) {
    doc.textRight(RIGHT - 92, right + 1, label, { size: 7.5, font: 'bold', colour: muted });
    doc.textRight(RIGHT, right, value, { size: 9.5, colour: ink });
    right += 15;
  }

  let cursor = Math.max(left, right) + 16;

  if (model.summary) {
    cursor += doc.paragraph(MARGIN, cursor, model.summary, RIGHT - MARGIN, { size: 9, colour: muted });
    cursor += 8;
  }

  // ---- the money -----------------------------------------------------------
  if (model.kind === 'receipt') {
    // A receipt has one figure and it should dominate the page.
    doc.rect(MARGIN, cursor, RIGHT - MARGIN, 60, [0.965, 0.973, 0.980]);
    doc.text(MARGIN + 18, cursor + 22, 'AMOUNT RECEIVED', { size: 7.5, font: 'bold', colour: muted });
    doc.text(MARGIN + 18, cursor + 48, money(model.receivedAmount ?? 0, model.currency),
      { size: 20, font: 'bold', colour: accent });
    cursor += 82;
  } else {
    const cols = { qty: MARGIN + 300, unit: MARGIN + 380, tax: MARGIN + 430, amount: RIGHT };
    // A tinted band behind the column headings. Floating grey labels above hairlines
    // read as captions; a band reads as a table, which is what this is.
    doc.rect(MARGIN, cursor - 11, RIGHT - MARGIN, 20, [0.957, 0.969, 0.976]);
    doc.text(MARGIN + 8, cursor, 'DESCRIPTION', { size: 7.5, font: 'bold', colour: muted });
    doc.textRight(cols.qty, cursor, 'QTY', { size: 7.5, font: 'bold', colour: muted });
    doc.textRight(cols.unit, cursor, 'UNIT', { size: 7.5, font: 'bold', colour: muted });
    doc.textRight(cols.tax, cursor, 'TAX', { size: 7.5, font: 'bold', colour: muted });
    doc.textRight(cols.amount, cursor - 0, 'AMOUNT', { size: 7.5, font: 'bold', colour: muted });
    cursor += 20;

    for (const line of model.lines) {
      const used = doc.paragraph(MARGIN + 8, cursor, line.description, 280, { size: 9.5, colour: ink });
      doc.textRight(cols.qty, cursor, String(line.quantity), { size: 9.5, colour: ink });
      doc.textRight(cols.unit, cursor, amount(line.unitPrice), { size: 9.5, colour: ink });
      doc.textRight(cols.tax, cursor, line.taxRate > 0 ? `${line.taxRate}%` : '-', { size: 9.5, colour: muted });
      doc.textRight(cols.amount, cursor, amount(line.amount), { size: 9.5, colour: ink });
      cursor += Math.max(used, 14) + 4;
      doc.line(MARGIN, cursor - 6, RIGHT, { colour: [0.93, 0.95, 0.96] });
    }

    cursor += 10;
    const totalsLeft = RIGHT - 200;
    const row = (label: string, value: string, bold = false) => {
      doc.text(totalsLeft, cursor, label, { size: 9.5, font: bold ? 'bold' : 'regular', colour: bold ? ink : muted });
      doc.textRight(RIGHT, cursor, value, { size: bold ? 11 : 9.5, font: bold ? 'bold' : 'regular', colour: ink });
      cursor += bold ? 20 : 15;
    };
    row('Subtotal', money(model.subtotal, model.currency));
    if (model.tax > 0) row('Tax', money(model.tax, model.currency));
    doc.line(totalsLeft, cursor - 4, RIGHT, { colour: [0.80, 0.84, 0.88] });
    cursor += 8;

    // The figure the reader is actually looking for, on a band of its own.
    const totalLabel = model.kind === 'quotation' ? 'Total' : 'Total due';
    const totalValue = model.amountPaid > 0
      ? money(model.total - model.amountPaid, model.currency)
      : money(model.total, model.currency);
    if (model.amountPaid > 0) {
      row('Paid', `-${money(model.amountPaid, model.currency)}`);
    }
    doc.rect(totalsLeft - 12, cursor - 12, RIGHT - totalsLeft + 12, 28, [0.957, 0.969, 0.976]);
    doc.text(totalsLeft, cursor + 5, model.amountPaid > 0 ? 'Balance' : totalLabel,
      { size: 10, font: 'bold', colour: ink });
    doc.textRight(RIGHT - 4, cursor + 5, totalValue, { size: 12.5, font: 'bold', colour: accent });
    cursor += 34;
  }

  // ---- terms, instructions, footer ----------------------------------------
  if (model.kind !== 'receipt' && profile.payment_instructions) {
    doc.text(MARGIN, cursor, 'HOW TO PAY', { size: 7.5, font: 'bold', colour: muted });
    cursor += 13;
    cursor += doc.paragraph(MARGIN, cursor, profile.payment_instructions, RIGHT - MARGIN,
      { size: 9, colour: ink });
    cursor += 10;
  }
  if (model.terms) {
    doc.text(MARGIN, cursor, 'TERMS', { size: 7.5, font: 'bold', colour: muted });
    cursor += 13;
    cursor += doc.paragraph(MARGIN, cursor, model.terms, RIGHT - MARGIN, { size: 9, colour: muted });
  }

  // ---- signatures ----------------------------------------------------------
  const slots = model.signatures ?? [];
  if (slots.length > 0) {
    // Kept clear of the footer, and pushed to a sensible band on the page so the
    // signature area is where a reader expects it rather than wherever the lines ended.
    const top = Math.min(Math.max(cursor + 24, A4.height - 210), A4.height - 150);
    const columnWidth = (RIGHT - MARGIN) / slots.length;

    slots.forEach((slot, index) => {
      const x = MARGIN + index * columnWidth;
      const inner = columnWidth - 16;

      if (slot.image) {
        // Scaled to fit the slot rather than its natural size: a signature exported at
        // 2000px would otherwise run across the whole page.
        const width = Math.min(inner, 110);
        doc.image(x, top + 4, slot.image, width);
      }

      doc.line(x, top + 44, x + inner, { colour: [0.10, 0.14, 0.19], width: 0.8 });
      doc.text(x, top + 56, slot.label, { size: 7, font: 'bold', colour: muted });
      if (slot.signerName) {
        doc.text(x, top + 68, slot.signerName, { size: 8.5, font: 'bold', colour: ink });
        doc.text(x, top + 79, slot.signedOn ?? '', { size: 7.5, colour: muted });
        if (!slot.valid) {
          // Stated on the paper, not only in the application: whoever reads the printed
          // copy is the person who most needs to know.
          doc.text(x, top + 90, 'document changed after signing',
            { size: 7, colour: [0.75, 0.16, 0.16] });
        }
      } else {
        doc.text(x, top + 68, 'Not yet signed', { size: 7.5, colour: muted });
      }
    });
  }

  const footer = model.kind === 'receipt' ? profile.receipt_footer : profile.invoice_footer;
  if (footer) {
    doc.line(MARGIN, A4.height - 66, RIGHT, { colour: [0.93, 0.95, 0.96] });
    doc.paragraph(MARGIN, A4.height - 54, footer, RIGHT - MARGIN, { size: 8, colour: muted });
  }

  return doc.toBuffer();
}

/**
 * The email body.
 *
 * Table-based and inline-styled because that is what mail clients render — Outlook in
 * particular ignores most of a stylesheet. A plain-text alternative goes alongside it so
 * the message is readable in a client that shows neither.
 */
export function renderEmailHtml(model: RenderModel, profile: Profile, intro: string): string {
  const accentHex = profile.accent_colour ?? '#1A6288';
  const esc = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rows = model.kind === 'receipt'
    ? `<tr><td style="padding:14px 0;font:600 20px Helvetica,Arial,sans-serif;color:${accentHex}">
         ${esc(money(model.receivedAmount ?? 0, model.currency))}</td></tr>`
    : model.lines.map((line) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eef2f6;font:14px Helvetica,Arial,sans-serif;color:#1a2430">
            ${esc(line.description)}
          </td>
          <td align="right" style="padding:8px 0;border-bottom:1px solid #eef2f6;font:14px Helvetica,Arial,sans-serif;color:#1a2430;white-space:nowrap">
            ${esc(amount(line.amount))}
          </td>
        </tr>`).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <!-- Declared explicitly: a client that guesses Latin-1 renders every non-ASCII
       character as mojibake, and payment instructions are full of them. -->
</head>
<body style="margin:0;padding:0;background:#f4f6f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:28px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;
                box-shadow:0 1px 3px rgba(8,45,66,.10)">
    <tr><td style="background:${accentHex};padding:22px 28px">
      <div style="font:700 20px Helvetica,Arial,sans-serif;color:#ffffff;letter-spacing:.5px">
        ${TITLE[model.kind]}
      </div>
      <div style="font:14px Helvetica,Arial,sans-serif;color:rgba(255,255,255,.85);margin-top:2px">
        ${esc(model.number)}
      </div>
    </td></tr>

    <tr><td style="padding:26px 28px 8px">
      <p style="margin:0 0 16px;font:15px/1.5 Helvetica,Arial,sans-serif;color:#1a2430">
        ${esc(intro)}
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      ${model.kind === 'receipt' ? '' : `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px">
        <tr>
          <td style="font:700 15px Helvetica,Arial,sans-serif;color:#1a2430;padding-top:8px">
            ${model.kind === 'quotation' ? 'Total' : 'Total due'}
          </td>
          <td align="right" style="font:700 15px Helvetica,Arial,sans-serif;color:#1a2430;padding-top:8px">
            ${esc(money(model.total - model.amountPaid, model.currency))}
          </td>
        </tr>
        ${model.dueLabel && model.dueDate ? `<tr><td colspan="2"
          style="font:13px Helvetica,Arial,sans-serif;color:#5b6a7a;padding-top:6px">
          ${esc(model.dueLabel.toLowerCase())} ${esc(model.dueDate)}</td></tr>` : ''}
      </table>`}
    </td></tr>

    ${profile.payment_instructions && model.kind !== 'receipt' ? `
    <tr><td style="padding:8px 28px 4px">
      <div style="background:#f6f8fa;border-radius:8px;padding:14px 16px">
        <div style="font:600 11px Helvetica,Arial,sans-serif;color:#7a8794;letter-spacing:.8px">HOW TO PAY</div>
        <div style="font:13px/1.5 Helvetica,Arial,sans-serif;color:#1a2430;margin-top:4px;white-space:pre-wrap">${esc(profile.payment_instructions)}</div>
      </div>
    </td></tr>` : ''}

    <tr><td style="padding:16px 28px 26px">
      <p style="margin:0;font:13px/1.5 Helvetica,Arial,sans-serif;color:#5b6a7a">
        The full ${model.kind} is attached as a PDF.
      </p>
    </td></tr>

    <tr><td style="background:#f6f8fa;padding:16px 28px;
                   font:12px/1.5 Helvetica,Arial,sans-serif;color:#7a8794">
      ${esc(profile.legal_name ?? '')}${profile.address_line1 ? ` &middot; ${esc(profile.address_line1)}` : ''}${profile.city ? `, ${esc(profile.city)}` : ''}<br>
      ${profile.contact_email ? esc(profile.contact_email) : ''}${profile.contact_phone ? ` &middot; ${esc(profile.contact_phone)}` : ''}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** Billing settings, with defaults, so a caller never has to handle their absence. */
export async function billingProfile(companyId: string): Promise<Profile> {
  const row = await one<Profile>('SELECT * FROM billing_settings WHERE company_id = $1', [companyId]);
  if (row) return { ...row, logo: await loadLogo(row.logo_file_id ?? null) };
  const company = await one<{ name: string; legal_name: string | null }>(
    'SELECT name, legal_name FROM companies WHERE id = $1', [companyId],
  );
  return {
    legal_name: company?.legal_name ?? company?.name ?? null,
    address_line1: null, address_line2: null, city: null, postal_code: null, country: null,
    tax_registration: null, contact_email: null, contact_phone: null,
    payment_instructions: null, invoice_footer: null, receipt_footer: null, accent_colour: null,
    logo_file_id: null, logo: null,
  };
}

/**
 * The company logo, decoded ready to draw.
 *
 * PNG only: the PDF writer embeds raw pixels, and a JPEG or SVG would need a decoder
 * apiece. A logo that cannot be read is not an error - the document falls back to the
 * legal name in type, which is what it did before logos existed at all.
 */
async function loadLogo(fileId: string | null): Promise<Profile['logo']> {
  if (!fileId) return null;
  const row = await one<{ object_key: string | null; mime_type: string | null }>(
    `SELECT v.object_key, f.mime_type
       FROM files f
       LEFT JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
      WHERE f.id = $1`,
    [fileId],
  );
  if (!row?.object_key || row.mime_type !== 'image/png') return null;
  try {
    const stream = await readStream(row.object_key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return decodePng(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

/** Assembles the model for an invoice, a quotation, or a payment receipt. */
export async function buildModel(kind: DocumentKind, documentId: string): Promise<RenderModel | null> {
  const partyLines = (o: Record<string, unknown>) =>
    [o.representative, o.address_line1, o.address_line2,
     [o.city, o.postal_code].filter(Boolean).join(' ') || null, o.country,
     o.tax_registration ? `Tax reg. ${o.tax_registration}` : null, o.billing_email]
      .filter((v): v is string => Boolean(v && String(v).trim()));

  if (kind === 'quotation') {
    const q = await one<Record<string, unknown>>(
      `SELECT q.*, o.name AS org_name, o.representative, o.address_line1, o.address_line2,
              o.city, o.postal_code, o.country, o.tax_registration, o.billing_email
         FROM quotations q JOIN external_organizations o ON o.id = q.org_id WHERE q.id = $1`,
      [documentId],
    );
    if (!q) return null;
    const lines = await many<Record<string, unknown>>(
      'SELECT description, quantity, unit_price, tax_rate, amount FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order',
      [documentId],
    );
    return {
      kind, number: String(q.number), currency: String(q.currency),
      issueDate: formatDate(q.issue_date),
      dueLabel: q.valid_until ? 'VALID UNTIL' : null,
      dueDate: q.valid_until ? formatDate(q.valid_until) : null,
      partyName: String(q.org_name), partyLines: partyLines(q),
      projectName: null, summary: (q.summary as string) ?? null,
      lines: lines.map((l) => ({
        description: String(l.description), quantity: Number(l.quantity),
        unitPrice: Number(l.unit_price), taxRate: Number(l.tax_rate), amount: Number(l.amount),
      })),
      subtotal: Number(q.subtotal), tax: Number(q.tax_amount), total: Number(q.total),
      amountPaid: 0, receivedAmount: null, method: null, reference: null,
      terms: (q.terms as string) ?? null,
    };
  }

  if (kind === 'invoice') {
    const i = await one<Record<string, unknown>>(
      `SELECT i.*, o.name AS org_name, o.representative, o.address_line1, o.address_line2,
              o.city, o.postal_code, o.country, o.tax_registration, o.billing_email,
              p.name AS project_name
         FROM invoices i
         JOIN external_organizations o ON o.id = i.client_org_id
         LEFT JOIN projects p ON p.id = i.project_id
        WHERE i.id = $1`,
      [documentId],
    );
    if (!i) return null;
    const lines = await many<Record<string, unknown>>(
      'SELECT description, quantity, unit_price, tax_rate, amount FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
      [documentId],
    );
    return {
      kind, number: String(i.number), currency: String(i.currency),
      issueDate: formatDate(i.issue_date),
      dueLabel: 'DUE', dueDate: formatDate(i.due_date),
      partyName: String(i.org_name), partyLines: partyLines(i),
      projectName: (i.project_name as string) ?? null, summary: null,
      lines: lines.map((l) => ({
        description: String(l.description), quantity: Number(l.quantity),
        unitPrice: Number(l.unit_price), taxRate: Number(l.tax_rate), amount: Number(l.amount),
      })),
      subtotal: Number(i.subtotal), tax: Number(i.tax_amount), total: Number(i.total),
      amountPaid: Number(i.amount_paid), receivedAmount: null, method: null, reference: null,
      terms: (i.terms as string) ?? null,
    };
  }

  const p = await one<Record<string, unknown>>(
    `SELECT p.*, i.number AS invoice_number, i.currency, i.total AS invoice_total,
            i.amount_paid, o.name AS org_name, o.representative, o.address_line1,
            o.address_line2, o.city, o.postal_code, o.country, o.tax_registration, o.billing_email
       FROM invoice_payments p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN external_organizations o ON o.id = i.client_org_id
      WHERE p.id = $1`,
    [documentId],
  );
  if (!p) return null;
  return {
    kind, number: String(p.receipt_number ?? ''), currency: String(p.currency),
    issueDate: formatDate(p.paid_on),
    dueLabel: 'FOR INVOICE', dueDate: String(p.invoice_number),
    partyName: String(p.org_name), partyLines: partyLines(p),
    projectName: null, summary: null, lines: [],
    subtotal: 0, tax: 0, total: Number(p.invoice_total),
    amountPaid: Number(p.amount_paid), receivedAmount: Number(p.amount),
    method: String(p.method), reference: (p.reference as string) ?? null, terms: null,
  };
}


/**
 * The signature slots for a document, with the images decoded ready to draw.
 *
 * Reads the bytes from object storage: the PDF has to carry the image itself, because
 * the person opening the attachment is outside the system and cannot follow a link into
 * it.
 *
 * A signature whose image cannot be read still produces a slot with the name and date.
 * Losing the picture is cosmetic; losing the record of who signed would not be.
 */
export async function signatureSlots(
  kind: DocumentKind,
  documentId: string,
): Promise<SignatureSlot[]> {
  const rows = await many<{
    role: string; signer_name: string; signed_at: Date; signed_hash: string;
    image_file_id: string | null; object_key: string | null; mime_type: string | null;
  }>(
    `SELECT s.role, s.signer_name, s.signed_at, s.signed_hash, s.image_file_id,
            v.object_key, f.mime_type
       FROM document_signatures s
       LEFT JOIN files f ON f.id = s.image_file_id
       -- The column is 'version', not 'version_number'. Getting that wrong made every
       -- document email fail: the query threw, the send threw, and the outbox retried
       -- silently until it gave up. No backticks here on purpose - this is inside a
       -- template literal, and one would end the string.
       LEFT JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
      WHERE s.document_type = $1 AND s.document_id = $2`,
    [kind, documentId],
  );

  const required = kind === 'receipt'
    ? ['internal_1', 'internal_2', 'client_1', 'client_2']
    : ['internal_1', 'internal_2', 'client_1'];

  const labels: Record<string, string> = {
    internal_1: 'FOR US', internal_2: 'FOR US',
    client_1: 'FOR THE CLIENT', client_2: 'FOR THE CLIENT',
  };

  const slots: SignatureSlot[] = [];
  for (const role of required) {
    const row = rows.find((r) => r.role === role);
    let image: SignatureSlot['image'] = null;

    if (row?.object_key && row.mime_type === 'image/png') {
      try {
        const stream = await readStream(row.object_key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        image = decodePng(Buffer.concat(chunks));
      } catch {
        // Unreadable image: the slot still records who signed and when.
        image = null;
      }
    }

    const sameSide = required.filter((r) => labels[r] === labels[role]).length;
    slots.push({
      role,
      label: labels[role] + (sameSide > 1 ? (role.endsWith('_2') ? ' (2)' : ' (1)') : ''),
      signerName: row?.signer_name ?? null,
      signedOn: row ? formatDate(row.signed_at) : null,
      image,
      valid: true,
    });
  }
  return slots;
}
