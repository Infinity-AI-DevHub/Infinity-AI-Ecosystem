/**
 * How invoices and receipts present themselves.
 *
 * Everything here appears on a document a client reads, so the copy says where each
 * field lands rather than naming the column it is stored in.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useQuery } from '../lib/query';
import { useNotify } from '../lib/notify';
import { uploadWorkspaceFile } from '../lib/uploads';
import { InvoiceDocument } from './InvoiceDocument';

type Settings = {
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

/**
 * A stand-in invoice for the live preview.
 *
 * Fixed sample content on purpose: the point is to show how the letterhead, colour and
 * footers land, and real data would change under the person as they type.
 */
const SAMPLE = {
  number: 'INV-2026-0042',
  status: 'open',
  currency: 'LKR',
  issue_date: '2026-09-01',
  due_date: '2026-09-30',
  subtotal: 185000,
  tax_amount: 27750,
  total: 212750,
  amount_paid: 0,
  notes: null,
  terms: 'Payment due within 30 days of issue.',
  client_name: 'Acme Holdings (Pvt) Ltd',
  project_name: 'Website Rebuild',
  representative: 'Managing Director',
  billing_email: 'accounts@acme.example',
  address_line1: '42 Galle Road',
  address_line2: null,
  city: 'Colombo',
  postal_code: '00300',
  country: 'Sri Lanka',
  tax_registration: 'VAT-99887',
  lines: [
    { description: 'Design and build', quantity: 1, unit_price: 150000, tax_rate: 15, amount: 150000 },
    { description: 'Content migration', quantity: 7, unit_price: 5000, tax_rate: 15, amount: 35000 },
  ],
};

export function BillingSettings() {
  const { notify } = useNotify();
  const query = useQuery<Settings>('/billing/settings', (signal) =>
    api.get('/billing/settings', signal),
  );
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState<'invoice' | 'receipt'>('invoice');
  const [error, setError] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function uploadLogo(file: File) {
    setLogoError(null);
    setLogoBusy(true);
    try {
      if (file.type !== 'image/png') {
        throw new Error('Use a PNG. The document writer embeds pixels directly, and a JPEG or SVG cannot be read.');
      }
      const uploaded = await uploadWorkspaceFile<{ id: string }>(file);
      set({ logo_file_id: uploaded.id });
      const link = await api.get<{ url: string }>(`/files/${uploaded.id}/download`);
      setLogoUrl(link.url);
    } catch (err) {
      setLogoError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLogoBusy(false);
    }
  }

  // Seeded once the server answers; edits after that are the person's, not a refetch's.
  useEffect(() => {
    if (query.data && !form) setForm(query.data);
  }, [query.data, form]);

  // The stored logo is a file id; the preview needs a short-lived URL for it.
  useEffect(() => {
    const fileId = query.data?.logo_file_id;
    if (!fileId) return;
    let cancelled = false;
    void api.get<{ url: string }>(`/files/${fileId}/download`)
      .then((link) => { if (!cancelled) setLogoUrl(link.url); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [query.data?.logo_file_id]);

  if (!form) return <section className="panel"><p className="field-hint">Loading…</p></section>;

  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch('/billing/settings', {
        legalName: form!.legal_name,
        addressLine1: form!.address_line1,
        addressLine2: form!.address_line2,
        city: form!.city,
        postalCode: form!.postal_code,
        country: form!.country,
        taxRegistration: form!.tax_registration,
        contactEmail: form!.contact_email || null,
        contactPhone: form!.contact_phone,
        paymentInstructions: form!.payment_instructions,
        invoiceFooter: form!.invoice_footer,
        receiptFooter: form!.receipt_footer,
        defaultTerms: form!.default_terms,
        defaultDueDays: Number(form!.default_due_days),
        invoicePrefix: form!.invoice_prefix,
        receiptPrefix: form!.receipt_prefix,
        logoFileId: form!.logo_file_id,
      });
      notify({ severity: 'success', title: 'Billing details saved' });
      query.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  }

  const year = new Date().getFullYear();

  return (
    <div className="billing-designer">
    <form className="panel" onSubmit={save} aria-labelledby="billing-heading">
      <header className="panel-header">
        <span className="panel-title" id="billing-heading">Invoice and receipt details</span>
      </header>
      <p className="field-hint">
        These appear on every invoice and receipt sent to a client.
      </p>

      <div className="field">
        <label htmlFor="bs-legal">Legal name</label>
        <input id="bs-legal" value={form.legal_name ?? ''}
               onChange={(e) => set({ legal_name: e.target.value })} />
      </div>

      <div className="field">
        <label htmlFor="bs-addr1">Address</label>
        <input id="bs-addr1" value={form.address_line1 ?? ''}
               onChange={(e) => set({ address_line1: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="bs-addr2" className="visually-hidden">Address line 2</label>
        <input id="bs-addr2" placeholder="Line 2" value={form.address_line2 ?? ''}
               onChange={(e) => set({ address_line2: e.target.value })} />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="bs-city">City</label>
          <input id="bs-city" value={form.city ?? ''} onChange={(e) => set({ city: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="bs-postal">Postal code</label>
          <input id="bs-postal" value={form.postal_code ?? ''}
                 onChange={(e) => set({ postal_code: e.target.value })} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="bs-country">Country</label>
          <input id="bs-country" value={form.country ?? ''}
                 onChange={(e) => set({ country: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="bs-tax">Tax registration</label>
          <input id="bs-tax" value={form.tax_registration ?? ''}
                 onChange={(e) => set({ tax_registration: e.target.value })} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="bs-email">Billing contact email</label>
          <input id="bs-email" type="email" value={form.contact_email ?? ''}
                 onChange={(e) => set({ contact_email: e.target.value })} />
          <p className="field-hint">Where clients should reply about an invoice.</p>
        </div>
        <div className="field">
          <label htmlFor="bs-phone">Phone</label>
          <input id="bs-phone" value={form.contact_phone ?? ''}
                 onChange={(e) => set({ contact_phone: e.target.value })} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="bs-pay">Payment instructions</label>
        <textarea id="bs-pay" rows={3} value={form.payment_instructions ?? ''}
                  onChange={(e) => set({ payment_instructions: e.target.value })}
                  placeholder="Bank name, account number, branch, SWIFT" />
        <p className="field-hint">Printed on every invoice so a client knows where to pay.</p>
      </div>

      <div className="field">
        <label htmlFor="bs-terms">Default payment terms</label>
        <textarea id="bs-terms" rows={2} value={form.default_terms ?? ''}
                  onChange={(e) => set({ default_terms: e.target.value })} />
        <p className="field-hint">Pre-filled on a new invoice; editable per invoice.</p>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="bs-footer">Invoice footer</label>
          <textarea id="bs-footer" rows={2} value={form.invoice_footer ?? ''}
                    onChange={(e) => set({ invoice_footer: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="bs-rfooter">Receipt footer</label>
          <textarea id="bs-rfooter" rows={2} value={form.receipt_footer ?? ''}
                    onChange={(e) => set({ receipt_footer: e.target.value })} />
        </div>
      </div>

      <fieldset className="field">
        <legend>Numbering</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor="bs-iprefix">Invoice prefix</label>
            <input id="bs-iprefix" value={form.invoice_prefix}
                   onChange={(e) => set({ invoice_prefix: e.target.value.toUpperCase() })}
                   maxLength={12} pattern="[A-Z0-9-]+" />
            <p className="field-hint">Next: {form.invoice_prefix}-{year}-0001</p>
          </div>
          <div className="field">
            <label htmlFor="bs-rprefix">Receipt prefix</label>
            <input id="bs-rprefix" value={form.receipt_prefix}
                   onChange={(e) => set({ receipt_prefix: e.target.value.toUpperCase() })}
                   maxLength={12} pattern="[A-Z0-9-]+" />
            <p className="field-hint">Next: {form.receipt_prefix}-{year}-0001</p>
          </div>
          <div className="field">
            <label htmlFor="bs-due">Payment due after</label>
            <select id="bs-due" value={form.default_due_days}
                    onChange={(e) => set({ default_due_days: Number(e.target.value) })}>
              {[0, 7, 14, 21, 30, 45, 60, 90].map((d) => (
                <option key={d} value={d}>{d === 0 ? 'On receipt' : `${d} days`}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="field-hint">
          Letters, digits and hyphens only. Changing a prefix starts a new series; numbers
          already issued keep the prefix they were issued under.
        </p>
      </fieldset>

      {/* The mark that heads every invoice, quotation and receipt. Replaceable, because
          a logo changes and re-cutting the PDF writer for it would be absurd. */}
      <div className="field">
        <span className="label-row">Company logo</span>
        <div className="logo-setting">
          <div className="logo-preview">
            {logoUrl ? (
              <img src={logoUrl} alt="Company logo" />
            ) : (
              <span className="field-hint">No logo — documents show the legal name instead.</span>
            )}
          </div>
          <div className="logo-actions">
            <label className="ghost-button logo-upload">
              {form.logo_file_id ? 'Replace logo' : 'Upload logo'}
              <input
                type="file"
                accept="image/png"
                hidden
                disabled={logoBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadLogo(file);
                  event.target.value = '';
                }}
              />
            </label>
            {form.logo_file_id ? (
              <button type="button" className="ghost-button"
                      onClick={() => { set({ logo_file_id: null }); setLogoUrl(null); }}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
        <p className="field-hint">
          A PNG with a transparent background. It is placed above the document title and
          scaled to fit, so any reasonable shape works. Save to apply it.
        </p>
        {logoError ? <p className="field-error">{logoError}</p> : null}
      </div>

      <div className="field">
        <label htmlFor="bs-accent">Accent colour</label>
        <input
          id="bs-accent"
          type="color"
          value={form.accent_colour ?? '#1A6288'}
          onChange={(e) => set({ accent_colour: e.target.value })}
        />
        <p className="field-hint">Used for the heading and the rule beneath it.</p>
      </div>

      {error ? <p className="field-error">{error}</p> : null}
      <div className="dialog-actions">
        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save billing details'}
        </button>
      </div>
    </form>

    {/*
      The live preview, updating as the form is typed into rather than after saving.
      It renders through the same component the client's document uses, so what is being
      designed here is literally the thing that gets sent - not an approximation of it.
    */}
    <div className="billing-preview">
      <div className="panel-header">
        <span className="panel-title">Preview</span>
        <div className="table-actions">
          <button
            type="button"
            className={`chip ${previewMode === 'invoice' ? 'chip-active' : ''}`}
            onClick={() => setPreviewMode('invoice')}
          >
            Invoice
          </button>
          <button
            type="button"
            className={`chip ${previewMode === 'receipt' ? 'chip-active' : ''}`}
            onClick={() => setPreviewMode('receipt')}
          >
            Receipt
          </button>
        </div>
      </div>
      <div className="billing-preview-scale">
        <InvoiceDocument
          invoice={SAMPLE as never}
          profile={form as never}
          variant={previewMode}
          payment={{
            id: 'sample', amount: 212750, paid_on: '2026-09-14',
            method: 'bank_transfer', reference: 'BOC-88213',
            receipt_number: `${form.receipt_prefix}-2026-0007`,
          }}
        />
      </div>
    </div>
    </div>
  );
}
