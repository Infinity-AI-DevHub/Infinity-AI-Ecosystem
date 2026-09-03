/**
 * Sharing a task, document or folder with colleagues, clients or guests.
 *
 * One dialog for all three because it is one act — a grant naming who, what, and at what
 * level. The difference between "view" and "view and upload" is the capabilities in the
 * grant, and the copy says plainly which it is rather than leaving somebody to infer it.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useNotify } from '../lib/notify';
import { PeoplePicker } from './PeoplePicker';

export type ShareableType = 'task' | 'doc' | 'folder';

type Share = {
  id: string;
  user_id: string;
  display_name: string;
  email_display: string;
  access_level: string;
  capabilities: unknown;
};

const TYPE_LABEL: Record<ShareableType, string> = {
  task: 'task', doc: 'document', folder: 'folder',
};

export function ShareWith({
  resourceType,
  resourceId,
  resourceName,
  onClose,
}: {
  resourceType: ShareableType;
  resourceId: string;
  resourceName: string;
  onClose: () => void;
}) {
  const { notify } = useNotify();
  const [selected, setSelected] = useState<string[]>([]);
  const [access, setAccess] = useState<'view' | 'contribute'>('view');
  const [note, setNote] = useState('');
  const [people, setPeople] = useState<{
    id: string; display_name: string; email_display: string;
    access_level: string; organisation_name?: string | null;
  }[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    const [directory, current] = await Promise.all([
      // Not the employee directory: that one leaves guests out by design, which meant
      // the one kind of person this dialog exists to reach could never be selected.
      api.get<{ items: typeof people }>('/shares/candidates'),
      api.get<{ items: Share[] }>(`/shares/${resourceType}/${resourceId}`),
    ]);
    setPeople(directory.items);
    setShares(current.items);
  }

  useEffect(() => { void load().catch(() => undefined); }, [resourceType, resourceId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(`/shares/${resourceType}/${resourceId}`, {
        userIds: selected,
        access,
        note: note || null,
      });
      notify({
        severity: 'success',
        title: `Shared with ${selected.length} ${selected.length === 1 ? 'person' : 'people'}`,
        body: 'They have been emailed a link.',
      });
      setSelected([]);
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be shared');
    } finally {
      setSaving(false);
    }
  }

  async function revoke(userId: string) {
    try {
      await api.delete(`/shares/${resourceType}/${resourceId}/${userId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be revoked');
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={`Share ${resourceName}`}
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Share {resourceName}</h3>

        {shares.length > 0 ? (
          <div className="field">
            <span className="label-row">Already shared with</span>
            <ul className="plain-list">
              {shares.map((share) => (
                <li key={share.id}>
                  {share.display_name}
                  {share.access_level === 'guest' ? (
                    <span className="task-meta"> · guest</span>
                  ) : null}
                  <span className="field-hint"> {share.email_display}</span>{' '}
                  <button type="button" className="ghost-button"
                          onClick={() => void revoke(share.user_id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <PeoplePicker
          label="Share with"
          people={people}
          selected={selected}
          onChange={setSelected}
          emptyHint="Nobody selected yet. Clients and guests appear here too."
        />

        <fieldset className="field">
          <legend>What they can do</legend>

          {/* Cards rather than bare radios: the difference between these two options is
              the whole decision being made, and it deserves a sentence each. */}
          <label className={`choice ${access === 'view' ? 'choice-on' : ''}`}>
            <input type="radio" name="access" checked={access === 'view'}
                   onChange={() => setAccess('view')} />
            <span className="choice-text">
              <strong>View only</strong>
              <span>They can open it and read it. Nothing they do changes anything.</span>
            </span>
          </label>

          {resourceType === 'folder' ? (
            <label className={`choice ${access === 'contribute' ? 'choice-on' : ''}`}>
              <input type="radio" name="access" checked={access === 'contribute'}
                     onChange={() => setAccess('contribute')} />
              <span className="choice-text">
                <strong>View, upload and edit</strong>
                <span>They can add files to this folder and change what is already here.</span>
              </span>
            </label>
          ) : (
            <p className="field-hint">
              A {TYPE_LABEL[resourceType]} can only be shared to view. Letting an external
              contact change one is a different decision from letting them read it.
            </p>
          )}
        </fieldset>

        <label className="field">
          <span>Add a note <span className="field-hint">optional</span></span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Included in the email they receive." />
        </label>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          <button type="submit" className="primary-button" disabled={saving || selected.length === 0}>
            {saving ? 'Sharing…' : 'Share and notify'}
          </button>
        </div>
      </form>
    </div>
  );
}
