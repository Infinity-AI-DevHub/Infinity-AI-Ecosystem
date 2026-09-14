/**
 * Assets, licences and contracts, for the people who look after the company's equipment
 * and subscriptions.
 *
 * Equipment and vendors are the same screens Finance uses - one register, reached from
 * two places - so there is no second copy to drift. Licences, contracts and the expiry view
 * are new, and read and write through the service management API.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock, FileText, KeyRound, Plus } from 'lucide-react';
import { api, ApiError, type Paged } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { formatCurrency, formatDate } from '../../lib/format';
import { openExternal } from '../../lib/desktop';
import { uploadWorkspaceFile } from '../../lib/uploads';
import { Empty, ErrorState, Loading } from '../../components/States';
import { Assets, Vendors } from '../Finance';
import '../../styles/command.css';
import '../../styles/service.css';

type Licence = {
  id: string; name: string; vendorId: string | null; vendorName: string | null; licenceType: string; seats: number | null; used: number;
  cost: number | null; currency: string; billingPeriod: string | null; renewsOn: string | null; managedAt: string | null;
  ownerId: string | null; ownerName: string | null; status: 'active' | 'expired' | 'cancelled'; notes: string | null;
};
type Contract = {
  id: string; vendorId: string; vendorName: string; title: string; reference: string | null; startsOn: string | null; endsOn: string | null;
  noticeDays: number; noticeBy: string | null; autoRenews: boolean; value: number | null; currency: string; ownerId: string | null; ownerName: string | null;
  documentFileId: string | null; documentName: string | null; status: 'active' | 'ended' | 'cancelled'; notes: string | null;
};
type Vendor = { id: string; name: string };
type Person = { id: string; displayName: string };

type Tab = 'equipment' | 'licences' | 'contracts' | 'vendors' | 'expiring';

export default function ServiceAssets() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'equipment', label: 'Equipment', show: can('asset.read') },
    { id: 'licences', label: 'Software licences', show: can('licence.read') },
    { id: 'contracts', label: 'Vendor contracts', show: can('licence.read') },
    { id: 'vendors', label: 'Vendors', show: can('vendor.manage') },
    { id: 'expiring', label: 'Expiring soon', show: can('licence.read') },
  ];
  const visible = tabs.filter((t) => t.show);
  const tab = (visible.find((t) => t.id === params.get('tab'))?.id ?? visible[0]?.id) as Tab | undefined;

  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Service</p><h2>Assets &amp; licences</h2></div>
      </header>
      {visible.length === 0 ? <Empty title="Nothing to show" description="Your role does not include the asset register." /> : (
        <>
          <div className="tab-row" role="tablist" aria-label="Asset views">
            {visible.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'tab-active' : ''}`}
                onClick={() => setParams({ tab: t.id }, { replace: true })}>{t.label}</button>
            ))}
          </div>
          {tab === 'equipment' ? <Assets /> : null}
          {tab === 'vendors' ? <Vendors /> : null}
          {tab === 'licences' ? <Licences /> : null}
          {tab === 'contracts' ? <Contracts /> : null}
          {tab === 'expiring' ? <Expiring /> : null}
        </>
      )}
    </div>
  );
}

function useLookups() {
  const { can } = useSession();
  const vendors = useQuery<{ items: Vendor[] }>(can('vendor.manage') || can('licence.manage') ? '/vendors' : null, (signal) => api.get('/vendors', signal));
  const people = useQuery<Paged<Person>>(can('user.read') ? '/users?limit=100' : null, (signal) => api.get('/users?limit=100', signal));
  return { vendors: vendors.data?.items ?? [], people: people.data?.items ?? [] };
}

/* --------------------------------------------------------------------- licences */

function Licences() {
  const { can } = useSession();
  const list = useQuery<{ items: Licence[] }>('/service/licences', (signal) => api.get('/service/licences', signal));
  const [editing, setEditing] = useState<Licence | 'new' | null>(null);
  const [holdersOf, setHoldersOf] = useState<Licence | null>(null);

  if (list.loading && !list.data) return <Loading label="Loading licences" rows={4} />;
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = list.data!.items;

  return (
    <>
      <div className="sd-toolbar">
        <p className="field-hint">Licence keys are not stored here. Record where each key is managed instead.</p>
        {can('licence.manage') ? <button type="button" className="primary-button" onClick={() => setEditing('new')}><Plus size={15} aria-hidden="true" /> Add licence</button> : null}
      </div>
      {items.length === 0 ? <Empty icon={<KeyRound size={22} />} title="No licences recorded" description="Track subscriptions, seats and renewal dates so nothing renews unnoticed." /> : (
        <div className="sd-table-wrap">
          <table className="data-table sd-table">
            <thead><tr><th scope="col">Licence</th><th scope="col">Vendor</th><th scope="col">Seats</th><th scope="col">Cost</th><th scope="col">Renews</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {items.map((l) => {
                const full = l.seats !== null && l.used >= l.seats;
                return (
                  <tr key={l.id}>
                    <th scope="row">{l.name}{l.managedAt ? <span className="sd-sub">Managed at {l.managedAt}</span> : null}</th>
                    <td>{l.vendorName ?? '—'}</td>
                    <td className={full ? 'sd-target-breached' : ''}>{l.used}{l.seats !== null ? ` / ${l.seats}` : ''}</td>
                    <td>{l.cost !== null ? `${formatCurrency(l.cost, l.currency)}${l.billingPeriod === 'monthly' ? '/mo' : l.billingPeriod === 'yearly' ? '/yr' : ''}` : '—'}</td>
                    <td>{l.renewsOn ? formatDate(l.renewsOn) : '—'}</td>
                    <td>{l.ownerName ?? '—'}</td>
                    <td><span className={`sd-badge ${l.status === 'active' ? 'sd-status-resolved' : 'sd-status-closed'}`}>{l.status === 'active' ? 'Active' : l.status === 'expired' ? 'Expired' : 'Cancelled'}</span></td>
                    <td className="table-actions">
                      <button type="button" className="ghost-button" onClick={() => setHoldersOf(l)}>Holders</button>
                      {can('licence.manage') ? <button type="button" className="ghost-button" onClick={() => setEditing(l)}>Edit</button> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <LicenceDialog licence={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {holdersOf ? <HoldersDialog licence={holdersOf} onClose={() => { setHoldersOf(null); invalidate('/service/licences'); }} /> : null}
    </>
  );
}

function LicenceDialog({ licence, onClose }: { licence: Licence | null; onClose: () => void }) {
  const { vendors, people } = useLookups();
  const [form, setForm] = useState({
    name: licence?.name ?? '', vendorId: licence?.vendorId ?? '', licenceType: licence?.licenceType ?? 'subscription',
    seats: licence?.seats?.toString() ?? '', cost: licence?.cost?.toString() ?? '', currency: licence?.currency ?? 'USD',
    billingPeriod: licence?.billingPeriod ?? 'yearly', renewsOn: licence?.renewsOn ?? '', managedAt: licence?.managedAt ?? '',
    ownerId: licence?.ownerId ?? '', status: licence?.status ?? 'active', notes: licence?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="licence-title" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = {
            name: form.name, vendorId: form.vendorId || null, licenceType: form.licenceType, seats: form.seats === '' ? null : Number(form.seats),
            cost: form.cost === '' ? null : Number(form.cost), currency: form.currency, billingPeriod: form.billingPeriod || null,
            renewsOn: form.renewsOn || null, managedAt: form.managedAt || null, ownerId: form.ownerId || null, status: form.status, notes: form.notes || null,
          };
          try {
            if (licence) await api.put(`/service/licences/${licence.id}`, body); else await api.post('/service/licences', body);
            invalidate('/service/licences'); invalidate('/service/expiring'); onClose();
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The licence was not saved.'); }
        }}>
        <h3 id="licence-title">{licence ? 'Edit licence' : 'Add licence'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Name</span><input autoFocus value={form.name} onChange={set('name')} required minLength={2} maxLength={200} placeholder="Microsoft 365 Business Standard" /></label>
          <label className="field"><span>Vendor</span><select value={form.vendorId} onChange={set('vendorId')}><option value="">None</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label className="field"><span>Type</span><select value={form.licenceType} onChange={set('licenceType')}><option value="subscription">Subscription</option><option value="perpetual">Perpetual</option><option value="open_source">Open source</option><option value="trial">Trial</option></select></label>
          <label className="field"><span>Seats</span><input type="number" min={0} value={form.seats} onChange={set('seats')} placeholder="Unlimited" /></label>
          <label className="field"><span>Renews on</span><input type="date" value={form.renewsOn} onChange={set('renewsOn')} /></label>
          <label className="field"><span>Cost</span><input type="number" min={0} step="0.01" value={form.cost} onChange={set('cost')} /></label>
          <div className="sd-inline">
            <label className="field"><span>Currency</span><input value={form.currency} onChange={set('currency')} maxLength={3} /></label>
            <label className="field"><span>Billed</span><select value={form.billingPeriod} onChange={set('billingPeriod')}><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="one_off">Once</option></select></label>
          </div>
          <label className="field sd-span-2"><span>Where the key is managed</span><input value={form.managedAt} onChange={set('managedAt')} maxLength={300} placeholder="e.g. Microsoft 365 admin centre" /></label>
          <label className="field"><span>Owner</span><select value={form.ownerId} onChange={set('ownerId')}><option value="">Licence managers</option>{people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field"><span>Status</span><select value={form.status} onChange={set('status')}><option value="active">Active</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></label>
          <label className="field sd-span-2"><span>Notes</span><textarea rows={2} value={form.notes} onChange={set('notes')} maxLength={5000} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {licence ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete ${licence.name}? Release any assigned seats first.`)) return;
            try { await api.delete(`/service/licences/${licence.id}`); invalidate('/service/licences'); invalidate('/service/expiring'); onClose(); }
            catch (err) { setError(err instanceof ApiError ? err.message : 'The licence was not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save</button>
        </div>
      </form>
    </div>
  );
}

function HoldersDialog({ licence, onClose }: { licence: Licence; onClose: () => void }) {
  const { can } = useSession();
  const { people } = useLookups();
  const key = `/service/licences/${licence.id}/holders`;
  const holders = useQuery<{ items: { id: string; display_name: string; email: string; status: string }[] }>(key, (signal) => api.get(key, signal));
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not go through.'); }
    invalidate(key);
  };
  const held = new Set(holders.data?.items.map((h) => h.id));
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="holders-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h3 id="holders-title">{licence.name}</h3>
        <p className="field-hint">{holders.data?.items.length ?? 0}{licence.seats !== null ? ` of ${licence.seats}` : ''} seats in use</p>
        {!holders.data ? <Loading rows={2} /> : holders.data.items.length === 0 ? <p className="cc-empty">Nobody holds this licence.</p> : (
          <ul className="cc-rows">
            {holders.data.items.map((h) => (
              <li key={h.id} className="cc-row">
                <span className="cc-row-main"><strong>{h.display_name}</strong><span>{h.email}{h.status !== 'active' ? ` · ${h.status}` : ''}</span></span>
                {can('licence.manage') ? <button type="button" className="ghost-button" onClick={() => void act(() => api.delete(`/service/licences/${licence.id}/holders/${h.id}`))}>Release</button> : null}
              </li>
            ))}
          </ul>
        )}
        {can('licence.manage') ? (
          <div className="sd-inline">
            <select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Assign to…</option>
              {people.filter((p) => !held.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
            <button type="button" className="primary-button" disabled={!userId} onClick={() => void act(async () => { await api.post(`/service/licences/${licence.id}/holders`, { userId }); setUserId(''); })}>Assign</button>
          </div>
        ) : null}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- contracts */

function Contracts() {
  const { can } = useSession();
  const list = useQuery<{ items: Contract[] }>('/service/contracts', (signal) => api.get('/service/contracts', signal));
  const [editing, setEditing] = useState<Contract | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (list.loading && !list.data) return <Loading label="Loading contracts" rows={4} />;
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="sd-toolbar">
        <span />
        {can('licence.manage') ? <button type="button" className="primary-button" onClick={() => setEditing('new')}><Plus size={15} aria-hidden="true" /> Add contract</button> : null}
      </div>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {list.data!.items.length === 0 ? <Empty icon={<FileText size={22} />} title="No contracts recorded" description="Record support agreements, leases and service contracts with their notice periods." /> : (
        <div className="sd-table-wrap">
          <table className="data-table sd-table">
            <thead><tr><th scope="col">Contract</th><th scope="col">Vendor</th><th scope="col">Term</th><th scope="col">Give notice by</th><th scope="col">Value</th><th scope="col">Owner</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              {list.data!.items.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.title}{c.reference ? <span className="sd-sub">{c.reference}</span> : null}</th>
                  <td>{c.vendorName}</td>
                  <td>{c.startsOn ? formatDate(c.startsOn) : '—'} – {c.endsOn ? formatDate(c.endsOn) : 'open-ended'}{c.autoRenews ? <span className="sd-sub">Renews automatically</span> : null}</td>
                  <td className={c.noticeBy && c.noticeBy <= today && c.status === 'active' ? 'sd-target-breached' : ''}>{c.noticeBy ? formatDate(c.noticeBy) : '—'}</td>
                  <td>{c.value !== null ? formatCurrency(c.value, c.currency) : '—'}</td>
                  <td>{c.ownerName ?? '—'}</td>
                  <td className="table-actions">
                    {c.documentFileId ? <button type="button" className="ghost-button" onClick={async () => {
                      setError(null);
                      try { const link = await api.get<{ url: string }>(`/service/contracts/${c.id}/document`); await openExternal(link.url); }
                      catch (err) { setError(err instanceof ApiError ? err.message : 'The document could not be opened.'); }
                    }}>Document</button> : null}
                    {can('licence.manage') ? <button type="button" className="ghost-button" onClick={() => setEditing(c)}>Edit</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <ContractDialog contract={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function ContractDialog({ contract, onClose }: { contract: Contract | null; onClose: () => void }) {
  const { vendors, people } = useLookups();
  const [form, setForm] = useState({
    vendorId: contract?.vendorId ?? '', title: contract?.title ?? '', reference: contract?.reference ?? '', startsOn: contract?.startsOn ?? '',
    endsOn: contract?.endsOn ?? '', noticeDays: String(contract?.noticeDays ?? 30), autoRenews: contract?.autoRenews ?? false,
    value: contract?.value?.toString() ?? '', currency: contract?.currency ?? 'USD', ownerId: contract?.ownerId ?? '',
    status: contract?.status ?? 'active', notes: contract?.notes ?? '', documentFileId: contract?.documentFileId ?? '',
  });
  const [documentName, setDocumentName] = useState(contract?.documentName ?? '');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="contract-title" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = {
            vendorId: form.vendorId, title: form.title, reference: form.reference || null, startsOn: form.startsOn || null, endsOn: form.endsOn || null,
            noticeDays: Number(form.noticeDays || 0), autoRenews: form.autoRenews, value: form.value === '' ? null : Number(form.value), currency: form.currency,
            ownerId: form.ownerId || null, documentFileId: form.documentFileId || null, status: form.status, notes: form.notes || null,
          };
          try {
            if (contract) await api.put(`/service/contracts/${contract.id}`, body); else await api.post('/service/contracts', body);
            invalidate('/service/contracts'); invalidate('/service/expiring'); onClose();
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The contract was not saved.'); }
        }}>
        <h3 id="contract-title">{contract ? 'Edit contract' : 'Add contract'}</h3>
        {vendors.length === 0 ? <p className="field-hint">Add the vendor first, on the Vendors tab.</p> : null}
        <div className="sd-form-grid">
          <label className="field"><span>Vendor</span><select value={form.vendorId} onChange={set('vendorId')} required><option value="">Choose a vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label className="field"><span>Reference</span><input value={form.reference} onChange={set('reference')} maxLength={120} /></label>
          <label className="field sd-span-2"><span>Title</span><input autoFocus value={form.title} onChange={set('title')} required minLength={2} maxLength={200} placeholder="Managed network support" /></label>
          <label className="field"><span>Starts</span><input type="date" value={form.startsOn} onChange={set('startsOn')} /></label>
          <label className="field"><span>Ends</span><input type="date" value={form.endsOn} onChange={set('endsOn')} /></label>
          <label className="field"><span>Notice period (days)</span><input type="number" min={0} value={form.noticeDays} onChange={set('noticeDays')} /></label>
          <label className="field sd-check-field"><span>Renewal</span><label className="sd-check"><input type="checkbox" checked={form.autoRenews} onChange={(e) => setForm({ ...form, autoRenews: e.target.checked })} /> Renews automatically</label></label>
          <label className="field"><span>Value</span><input type="number" min={0} step="0.01" value={form.value} onChange={set('value')} /></label>
          <label className="field"><span>Currency</span><input value={form.currency} onChange={set('currency')} maxLength={3} /></label>
          <label className="field"><span>Owner</span><select value={form.ownerId} onChange={set('ownerId')}><option value="">Licence managers</option>{people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          <label className="field"><span>Status</span><select value={form.status} onChange={set('status')}><option value="active">Active</option><option value="ended">Ended</option><option value="cancelled">Cancelled</option></select></label>
          <div className="field sd-span-2">
            <span>Signed document</span>
            <div className="sd-inline">
              <span className="field-hint">{documentName || 'None attached'}</span>
              <label className="ghost-button">
                {uploading ? 'Uploading…' : documentName ? 'Replace' : 'Upload'}
                <input type="file" hidden disabled={uploading} onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true); setError(null);
                  try { const stored = await uploadWorkspaceFile<{ id: string; name: string }>(file); setForm((f) => ({ ...f, documentFileId: stored.id })); setDocumentName(stored.name); }
                  catch (err) { setError(err instanceof Error ? err.message : 'The document was not uploaded.'); }
                  finally { setUploading(false); }
                }} />
              </label>
            </div>
          </div>
          <label className="field sd-span-2"><span>Notes</span><textarea rows={2} value={form.notes} onChange={set('notes')} maxLength={5000} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {contract ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete the contract "${contract.title}"?`)) return;
            try { await api.delete(`/service/contracts/${contract.id}`); invalidate('/service/contracts'); invalidate('/service/expiring'); onClose(); }
            catch (err) { setError(err instanceof ApiError ? err.message : 'The contract was not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={uploading}>Save</button>
        </div>
      </form>
    </div>
  );
}

/* --------------------------------------------------------------------- expiring */

function Expiring() {
  const [days, setDays] = useState(60);
  const key = `/service/expiring?days=${days}`;
  const data = useQuery<{
    warranties: { id: string; tag: string; name: string; date: string; holder: string | null }[];
    renewals: { id: string; name: string; date: string; cost: number | null; currency: string }[];
    contracts: { id: string; title: string; vendorName: string; endsOn: string; noticeBy: string; autoRenews: boolean }[];
  }>(key, (signal) => api.get(key, signal));
  if (data.error && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading rows={4} />;
  const d = data.data;
  const nothing = d.warranties.length + d.renewals.length + d.contracts.length === 0;
  return (
    <>
      <div className="sd-toolbar">
        <p className="field-hint">Owners are reminded 30 and 7 days before each date.</p>
        <label className="nc-kind"><span className="visually-hidden">Window</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={30}>Next 30 days</option><option value={60}>Next 60 days</option><option value={90}>Next 90 days</option><option value={180}>Next 180 days</option></select>
        </label>
      </div>
      {nothing ? <Empty icon={<CalendarClock size={22} />} title="Nothing expiring" description={`No warranties, renewals or contract notice deadlines in the next ${days} days.`} /> : (
        <div className="cc-grid">
          <section className="cc-panel" aria-label="Contract notice deadlines">
            <header><h3>Contract notice deadlines</h3></header>
            {d.contracts.length === 0 ? <p className="cc-empty">None.</p> : <ul className="cc-rows">{d.contracts.map((c) => (
              <li key={c.id} className="cc-row"><span className="cc-row-main"><strong>{c.title}</strong><span>{c.vendorName} · ends {formatDate(c.endsOn)}{c.autoRenews ? ' · renews automatically' : ''}</span></span><span className="cc-tag cc-tag-critical">Notice by {formatDate(c.noticeBy)}</span></li>
            ))}</ul>}
          </section>
          <section className="cc-panel" aria-label="Licence renewals">
            <header><h3>Licence renewals</h3></header>
            {d.renewals.length === 0 ? <p className="cc-empty">None.</p> : <ul className="cc-rows">{d.renewals.map((r) => (
              <li key={r.id} className="cc-row"><span className="cc-row-main"><strong>{r.name}</strong><span>{r.cost !== null ? formatCurrency(r.cost, r.currency) : 'No cost recorded'}</span></span><span className="cc-tag">{formatDate(r.date)}</span></li>
            ))}</ul>}
          </section>
          <section className="cc-panel" aria-label="Warranties ending">
            <header><h3>Warranties ending</h3></header>
            {d.warranties.length === 0 ? <p className="cc-empty">None.</p> : <ul className="cc-rows">{d.warranties.map((w) => (
              <li key={w.id} className="cc-row"><span className="cc-row-main"><strong>{w.tag} · {w.name}</strong><span>{w.holder ? `Held by ${w.holder}` : 'In stock'}</span></span><span className="cc-tag">{formatDate(w.date)}</span></li>
            ))}</ul>}
          </section>
        </div>
      )}
    </>
  );
}
