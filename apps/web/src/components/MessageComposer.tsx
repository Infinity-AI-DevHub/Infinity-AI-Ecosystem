/**
 * Writing a message to people from inside the platform.
 *
 * Sent as both an in-app notification and an email, because the two reach different
 * situations — one the person at their desk, the other the person who is not.
 *
 * Every message is recorded. "Did anyone tell the client" is a question that gets asked,
 * and a message with no trace is indistinguishable from one that was never sent.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, idempotencyKey } from '../lib/api';
import { useQuery } from '../lib/query';
import { useNotify } from '../lib/notify';
import { PeoplePicker } from './PeoplePicker';

type Sent = {
  id: string;
  subject: string;
  recipient_count: number;
  audience: string;
  sent_at: string;
  sent_by_name: string | null;
};

export function MessageComposer() {
  const { notify } = useNotify();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [userIds, setUserIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [orgIds, setOrgIds] = useState<string[]>([]);
  const [everyone, setEveryone] = useState(false);
  const [people, setPeople] = useState<{ id: string; display_name: string; email_display: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const groups = useQuery<{ items: { id: string; name: string }[] }>('/admin/groups', (signal) =>
    api.get('/admin/groups', signal),
  );
  const orgs = useQuery<{ items: { id: string; name: string }[] }>('/external/organizations', (signal) =>
    api.get('/external/organizations', signal),
  );
  const history = useQuery<{ items: Sent[] }>('/messages', (signal) => api.get('/messages', signal));

  useEffect(() => {
    void api.get<{ items: typeof people }>('/users?limit=200')
      .then((result) => setPeople(result.items))
      .catch(() => undefined);
  }, []);

  const reach = everyone
    ? 'everyone in the company'
    : `${userIds.length + groupIds.length + orgIds.length} selection(s)`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const result = await api.post<{ recipients: number }>('/messages', {
        subject, body,
        userIds: userIds.length ? userIds : undefined,
        groupIds: groupIds.length ? groupIds : undefined,
        orgIds: orgIds.length ? orgIds : undefined,
        everyone: everyone || undefined,
      }, { idempotencyKey: idempotencyKey() });
      notify({
        severity: 'success',
        title: `Sent to ${result.recipients} ${result.recipients === 1 ? 'person' : 'people'}`,
      });
      setSubject(''); setBody(''); setUserIds([]); setGroupIds([]); setOrgIds([]); setEveryone(false);
      history.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That message could not be sent');
    } finally {
      setSaving(false);
    }
  }

  const toggle = (list: string[], set: (next: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="module-page">
      <form className="panel" onSubmit={submit} aria-labelledby="composer-heading">
        <header className="panel-header">
          <span className="panel-title" id="composer-heading">Send a message</span>
        </header>

        <label className="field">
          <span>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)}
                 required maxLength={300} />
        </label>

        <label className="field">
          <span>Message</span>
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} required />
        </label>

        <div className="checkbox-row">
          <label>
            <input type="checkbox" checked={everyone}
                   onChange={(e) => setEveryone(e.target.checked)} />
            Everyone in the company
          </label>
        </div>

        {!everyone ? (
          <>
            <PeoplePicker label="People" people={people} selected={userIds}
                          onChange={setUserIds} emptyHint="Nobody chosen" />

            <fieldset className="field">
              <legend>Groups</legend>
              <div className="chip-row">
                {(groups.data?.items ?? []).map((group) => (
                  <button key={group.id} type="button"
                          className={`chip ${groupIds.includes(group.id) ? 'chip-active' : ''}`}
                          onClick={() => toggle(groupIds, setGroupIds, group.id)}>
                    {group.name}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="field">
              <legend>Clients and other organisations</legend>
              <p className="field-hint">Reaches their guest accounts here, not their whole company.</p>
              <div className="chip-row">
                {(orgs.data?.items ?? []).map((org) => (
                  <button key={org.id} type="button"
                          className={`chip ${orgIds.includes(org.id) ? 'chip-active' : ''}`}
                          onClick={() => toggle(orgIds, setOrgIds, org.id)}>
                    {org.name}
                  </button>
                ))}
              </div>
            </fieldset>
          </>
        ) : null}

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="submit" className="primary-button"
                  disabled={saving || !subject.trim() || !body.trim()}>
            {saving ? 'Sending…' : `Send to ${reach}`}
          </button>
        </div>
        <p className="field-hint">
          Delivered in the app and by email. You are never sent a copy of your own message.
        </p>
      </form>

      <section className="panel" aria-labelledby="sent-heading">
        <header className="panel-header">
          <span className="panel-title" id="sent-heading">Sent</span>
        </header>
        {(history.data?.items ?? []).length === 0 ? (
          <p className="field-hint">Nothing sent yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Subject</th><th>Recipients</th><th>Sent by</th><th>When</th></tr>
              </thead>
              <tbody>
                {history.data!.items.map((message) => (
                  <tr key={message.id}>
                    <td><strong>{message.subject}</strong></td>
                    <td>
                      {message.recipient_count}
                      {message.audience === 'everyone' ? ' · everyone' : ''}
                    </td>
                    <td>{message.sent_by_name ?? '—'}</td>
                    <td>{new Date(message.sent_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
