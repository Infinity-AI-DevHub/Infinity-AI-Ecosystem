/**
 * Managing leave types.
 *
 * The key is shown but never editable: balances and every historical request refer to a
 * type by key, so changing it would detach a year of leave from the thing it was booked
 * against. Retiring is a soft delete for the same reason - the type leaves the pickers
 * while everything already booked against it still resolves.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { invalidate, useQuery } from '../lib/query';
import { useNotify } from '../lib/notify';

type LeaveType = {
  id: string;
  key: string;
  name: string;
  colour: string | null;
  paid: number | boolean;
  requires_approval: number | boolean;
  deducts_balance: number | boolean;
  default_annual_days: number;
  active: number | boolean;
};

const on = (value: number | boolean) => value === true || value === 1;

export function LeaveTypeAdmin() {
  const { notify } = useNotify();
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [creating, setCreating] = useState(false);

  const types = useQuery<{ items: LeaveType[] }>(
    '/leave/types?includeInactive=true',
    (signal) => api.get('/leave/types?includeInactive=true', signal),
  );

  async function save(patch: Partial<LeaveType> & { id: string }) {
    const { id, ...rest } = patch;
    await api.patch(`/leave/types/${id}`, rest);
    invalidate('/leave/types');
    invalidate('/leave/balances');
    types.reload();
  }

  return (
    <section className="panel" aria-labelledby="leave-types-heading">
      <header className="panel-header">
        <span className="panel-title" id="leave-types-heading">Leave types</span>
        <button type="button" className="primary-button" onClick={() => setCreating(true)}>
          New leave type
        </button>
      </header>

      {(types.data?.items ?? []).length === 0 ? (
        <p className="field-hint">None configured yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th><th>Key</th><th>Days / year</th>
                <th>Paid</th><th>Approval</th><th>Deducts</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {types.data!.items.map((type) => (
                <tr key={type.id} style={{ opacity: on(type.active) ? 1 : 0.55 }}>
                  <td><strong>{type.name}</strong></td>
                  <td><code>{type.key}</code></td>
                  <td>{type.default_annual_days}</td>
                  <td>{on(type.paid) ? 'Yes' : 'No'}</td>
                  <td>{on(type.requires_approval) ? 'Required' : 'Automatic'}</td>
                  <td>{on(type.deducts_balance) ? 'Yes' : 'No'}</td>
                  <td>
                    <span className={`status-tag ${on(type.active) ? 'status-active' : 'status-suspended'}`}>
                      {on(type.active) ? 'Active' : 'Retired'}
                    </span>
                  </td>
                  <td className="table-actions">
                    <button type="button" className="ghost-button" onClick={() => setEditing(type)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={async () => {
                        try {
                          await save({ id: type.id, active: !on(type.active) } as never);
                          notify({
                            severity: 'success',
                            title: on(type.active) ? 'Leave type retired' : 'Leave type restored',
                            body: type.name,
                          });
                        } catch (err) {
                          notify({
                            severity: 'warning',
                            title: 'That did not save',
                            body: err instanceof ApiError ? err.message : undefined,
                          });
                        }
                      }}
                    >
                      {on(type.active) ? 'Retire' : 'Restore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateType
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); types.reload(); invalidate('/leave'); }}
        />
      ) : null}

      {editing ? (
        <EditType
          type={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); types.reload(); invalidate('/leave'); }}
        />
      ) : null}
    </section>
  );
}

function EditType({
  type, onClose, onSaved,
}: { type: LeaveType; onClose: () => void; onSaved: () => void }) {
  const { notify } = useNotify();
  const [name, setName] = useState(type.name);
  const [days, setDays] = useState(String(type.default_annual_days));
  const [paid, setPaid] = useState(on(type.paid));
  const [requiresApproval, setRequiresApproval] = useState(on(type.requires_approval));
  const [deductsBalance, setDeductsBalance] = useState(on(type.deducts_balance));
  const [colour, setColour] = useState(type.colour ?? '#1A6288');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/leave/types/${type.id}`, {
        name,
        defaultAnnualDays: Number(days),
        paid,
        requiresApproval,
        deductsBalance,
        colour,
      });
      notify({ severity: 'success', title: 'Leave type updated', body: name });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={`Edit ${type.name}`}
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Edit leave type</h3>

        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>

        <label className="field">
          <span>Key</span>
          <input value={type.key} disabled readOnly />
          <span className="field-hint">
            Fixed. Existing balances and requests refer to this type by its key, so
            changing it would detach them. Retire and replace instead.
          </span>
        </label>

        <div className="field-row">
          <label className="field">
            <span>Days per year</span>
            <input type="number" min="0" max="366" value={days}
                   onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="field">
            <span>Colour</span>
            <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} />
          </label>
        </div>

        <div className="checkbox-row">
          <label><input type="checkbox" checked={paid}
                        onChange={(e) => setPaid(e.target.checked)} /> Paid leave</label>
        </div>
        <div className="checkbox-row">
          <label><input type="checkbox" checked={requiresApproval}
                        onChange={(e) => setRequiresApproval(e.target.checked)} /> Needs approval</label>
        </div>
        <div className="checkbox-row">
          <label><input type="checkbox" checked={deductsBalance}
                        onChange={(e) => setDeductsBalance(e.target.checked)} /> Deducts from entitlement</label>
        </div>

        <p className="field-hint">
          Changing days per year affects future accrual. Balances already granted are not
          recalculated.
        </p>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}


/**
 * Creating a leave type.
 *
 * The key is set once here and never again: balances and requests refer to a type by
 * key, so it has to be right at creation. It is derived from the name as a starting
 * point rather than left blank, because the shape of a valid key is not obvious.
 */
function CreateType({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { notify } = useNotify();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [days, setDays] = useState('14');
  const [paid, setPaid] = useState(true);
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [deductsBalance, setDeductsBalance] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const slug = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post('/leave/types', {
        key: key || slug(name),
        name,
        defaultAnnualDays: Number(days),
        paid,
        requiresApproval,
        deductsBalance,
      });
      notify({ severity: 'success', title: 'Leave type created', body: name });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be created');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="New leave type"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New leave type</h3>

        <label className="field">
          <span>Name</span>
          <input
            value={name}
            autoFocus
            required
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(slug(e.target.value));
            }}
            placeholder="Annual Leave"
          />
        </label>

        <label className="field">
          <span>Key</span>
          <input
            value={key}
            required
            maxLength={40}
            onChange={(e) => { setKeyTouched(true); setKey(slug(e.target.value)); }}
          />
          <span className="field-hint">
            Permanent. Leave records refer to the type by this, so it cannot be changed
            later without detaching them.
          </span>
        </label>

        <label className="field">
          <span>Days per year</span>
          <input type="number" min="0" max="366" value={days}
                 onChange={(e) => setDays(e.target.value)} />
        </label>

        <div className="checkbox-row">
          <label><input type="checkbox" checked={paid}
                        onChange={(e) => setPaid(e.target.checked)} /> Paid leave</label>
        </div>
        <div className="checkbox-row">
          <label><input type="checkbox" checked={requiresApproval}
                        onChange={(e) => setRequiresApproval(e.target.checked)} /> Needs approval</label>
        </div>
        <div className="checkbox-row">
          <label><input type="checkbox" checked={deductsBalance}
                        onChange={(e) => setDeductsBalance(e.target.checked)} /> Deducts from entitlement</label>
        </div>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || !name}>
            {saving ? 'Creating…' : 'Create leave type'}
          </button>
        </div>
      </form>
    </div>
  );
}
