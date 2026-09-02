/**
 * A small form over one record.
 *
 * Five things needed the same dialog — a supplier, a budget, an expense category, an
 * asset, a group — and writing five near-identical components is how they drift apart.
 * The caller describes the fields; this owns the dialog, the PATCH, the pending state
 * and the error, so all five behave the same way when something goes wrong.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useNotify } from '../lib/notify';

export type FieldSpec = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'textarea' | 'select' | 'email';
  options?: { value: string; label: string }[];
  hint?: string;
  /** Shown but not editable, for things like an immutable key. */
  readOnly?: boolean;
  required?: boolean;
};

export function RecordEditor({
  title,
  path,
  fields,
  initial,
  onClose,
  onSaved,
  savedMessage,
}: {
  title: string;
  /** The PATCH target, e.g. `/vendors/abc`. */
  path: string;
  fields: FieldSpec[];
  initial: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
  savedMessage?: string;
}) {
  const { notify } = useNotify();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((field) => [field.name, initial[field.name] == null ? '' : String(initial[field.name])]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      for (const field of fields) {
        if (field.readOnly) continue;
        const raw = values[field.name] ?? '';
        // An empty optional field means "clear it", which is null rather than "".
        body[field.name] =
          raw === ''
            ? field.required ? '' : null
            : field.type === 'number' ? Number(raw) : raw;
      }
      await api.patch(path, body);
      notify({ severity: 'success', title: savedMessage ?? 'Saved' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={title}
            onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h3>{title}</h3>

        {fields.map((field) => (
          <label className="field" key={field.name}>
            <span>{field.label}</span>
            {field.type === 'textarea' ? (
              <textarea
                rows={3}
                value={values[field.name] ?? ''}
                readOnly={field.readOnly}
                onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              />
            ) : field.type === 'select' ? (
              <select
                value={values[field.name] ?? ''}
                disabled={field.readOnly}
                onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={field.type ?? 'text'}
                step={field.type === 'number' ? '0.01' : undefined}
                value={values[field.name] ?? ''}
                readOnly={field.readOnly}
                disabled={field.readOnly}
                required={field.required}
                onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              />
            )}
            {field.hint ? <span className="field-hint">{field.hint}</span> : null}
          </label>
        ))}

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
