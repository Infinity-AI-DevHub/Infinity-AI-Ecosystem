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
};

export function BillingSettings() {
  const { notify } = useNotify();
  const query = useQuery<Settings>('/billing/settings', (signal) =>
    api.get('/billing/settings', signal),
  );
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seeded once the server answers; edits after that are the person's, not a refetch's.
  useEffect(() => {
    if (query.data && !form) setForm(query.data);
  }, [query.data, form]);

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

      {error ? <p className="field-error">{error}</p> : null}
      <div className="dialog-actions">
        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save billing details'}
        </button>
      </div>
    </form>
  );
}
