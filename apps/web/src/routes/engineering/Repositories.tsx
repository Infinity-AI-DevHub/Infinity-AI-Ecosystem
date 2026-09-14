/**
 * Source control: the GitHub and GitLab webhook connections, and the repositories they have
 * reported, each linked to the service it builds.
 *
 * Repositories appear on their own when the first event arrives; nobody types them in.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/engineering.css';

type Connection = { id: string; provider: 'github' | 'gitlab'; name: string; isActive: boolean; lastReceivedAt: string | null; secretFingerprint: string; repositories: number; endpoint: string };
type Repo = { id: string; provider: string; fullName: string; url: string | null; defaultBranch: string | null; connectionName: string | null; service: { id: string; name: string } | null; lastPushAt: string | null; lastCommitMessage: string | null; lastPusher: string | null; openPullRequests: number; canLink: boolean };
type Revealed = { name: string; provider: 'github' | 'gitlab'; endpoint: string; secret: string };

export default function Repositories() {
  const { can, session } = useSession();
  const repos = useQuery<{ items: Repo[] }>('/engineering/repositories', (s) => api.get('/engineering/repositories', s));
  const services = useQuery<{ items: { id: string; name: string; owner: { id: string } | null }[] }>('/engineering/services', (s) => api.get('/engineering/services', s));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="module-page cc-page">
      <header className="cc-header"><div><p className="cc-eyebrow">Engineering</p><h2>Repositories</h2></div></header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {can('scm.manage') ? <Connections /> : null}
      {repos.loading && !repos.data ? <Loading rows={4} /> : repos.error && !repos.data ? <ErrorState error={repos.error} onRetry={repos.reload} />
        : repos.data!.items.length === 0 ? <Empty title="No repositories yet" description={can('scm.manage') ? 'Connect GitHub or GitLab above. Repositories appear when their first event arrives.' : 'An administrator connects GitHub or GitLab; repositories appear when events arrive.'} />
        : (
          <div className="sd-table-wrap">
            <table className="data-table sd-table">
              <thead><tr><th scope="col">Repository</th><th scope="col">Service</th><th scope="col">Last push</th><th scope="col">Open pull requests</th></tr></thead>
              <tbody>
                {repos.data!.items.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.fullName}</a> : r.fullName}<span className="sd-sub">{r.provider === 'github' ? 'GitHub' : 'GitLab'}{r.connectionName ? ` · ${r.connectionName}` : ''}{r.defaultBranch ? ` · ${r.defaultBranch}` : ''}</span></th>
                    <td>
                      {r.canLink ? (
                        <select aria-label={`Service for ${r.fullName}`} value={r.service?.id ?? ''} onChange={async (e) => {
                          setError(null);
                          try { await api.put(`/engineering/repositories/${r.id}/service`, { serviceId: e.target.value || null }); }
                          catch (err) { setError(err instanceof ApiError ? err.message : 'Not linked.'); }
                          invalidate('/engineering/');
                        }}>
                          <option value="">Not linked</option>
                          {services.data?.items.filter((s) => can('engineering.manage') || s.owner?.id === session?.user?.id || s.id === r.service?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      ) : r.service ? <Link to={`/engineering/services/${r.service.id}`}>{r.service.name}</Link> : <span className="sd-muted">Not linked</span>}
                    </td>
                    <td>{r.lastPushAt ? <>{relativeTime(r.lastPushAt)}<span className="sd-sub">{r.lastPusher ?? 'someone'}: {r.lastCommitMessage}</span></> : <span className="sd-muted">None yet</span>}</td>
                    <td>{r.openPullRequests}{can('engineering.manage') ? <> · <button type="button" className="sd-link-button" onClick={async () => {
                      if (!window.confirm(`Remove ${r.fullName} and its pull requests? It reappears if its webhook sends another event.`)) return;
                      setError(null);
                      try { await api.delete(`/engineering/repositories/${r.id}`); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not removed.'); }
                      invalidate('/engineering/');
                    }}>Remove</button></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

function Connections() {
  const list = useQuery<{ items: Connection[] }>('/engineering/scm/connections', (s) => api.get('/engineering/scm/connections', s));
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ provider: 'github' as 'github' | 'gitlab', name: '' });
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = async (c: Connection, body: { isActive?: boolean; rotate?: boolean }) => {
    setError(null);
    try {
      const res = await api.patch<{ endpoint: string; secret: string | null }>(`/engineering/scm/connections/${c.id}`, body);
      if (res.secret) setRevealed({ name: c.name, provider: c.provider, endpoint: res.endpoint, secret: res.secret });
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Not updated.'); }
    invalidate('/engineering/scm');
  };
  return (
    <section className="cc-panel" aria-label="Source control connections">
      <header><h3>Source control connections</h3>{!adding ? <button type="button" className="sd-link-button" onClick={() => setAdding(true)}><Plus size={13} aria-hidden="true" /> Connect</button> : null}</header>
      {error ? <p className="field-error sd-panel-pad" role="alert">{error}</p> : null}
      {adding ? (
        <form className="sd-panel-pad sd-inline" onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try {
            const res = await api.post<{ endpoint: string; secret: string }>('/engineering/scm/connections', f);
            setRevealed({ name: f.name, provider: f.provider, endpoint: res.endpoint, secret: res.secret });
            setAdding(false); setF({ provider: 'github', name: '' });
          } catch (err) { setError(err instanceof ApiError ? err.message : 'Not connected.'); }
          invalidate('/engineering/scm');
        }}>
          <select aria-label="Provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as 'github' | 'gitlab' })}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select>
          <input aria-label="Connection name" autoFocus required minLength={2} maxLength={120} placeholder="Acme organisation" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <button type="submit" className="primary-button">Create</button>
          <button type="button" className="sd-link-button" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : null}
      {revealed ? (
        <div className="eg-secret" role="status">
          <strong>Set up the webhook for {revealed.name} now. The secret is not shown again.</strong>
          <ol className="eg-steps">
            {revealed.provider === 'github' ? <>
              <li>In GitHub, open the organisation or repository settings, then Webhooks, then Add webhook.</li>
              <li>Payload URL: <code>{revealed.endpoint}</code></li>
              <li>Content type: <code>application/json</code>. Secret: <code>{revealed.secret}</code></li>
              <li>Choose Pushes, Pull requests and Deployment statuses.</li>
            </> : <>
              <li>In GitLab, open the group or project settings, then Webhooks, then Add new webhook.</li>
              <li>URL: <code>{revealed.endpoint}</code></li>
              <li>Secret token: <code>{revealed.secret}</code></li>
              <li>Choose Push events, Merge request events and Deployment events.</li>
            </>}
          </ol>
          <div className="sd-inline">
            <button type="button" className="ghost-button" onClick={() => navigator.clipboard?.writeText(`${revealed.endpoint}\n${revealed.secret}`)}><Copy size={14} aria-hidden="true" /> Copy address and secret</button>
            <button type="button" className="ghost-button" onClick={() => setRevealed(null)}>Done</button>
          </div>
        </div>
      ) : null}
      {!list.data ? <Loading rows={2} /> : list.data.items.length === 0 ? <p className="cc-empty">Not connected. Workspace receives webhooks; it never needs a token for your code.</p> : (
        <ul className="cc-rows">
          {list.data.items.map((c) => (
            <li key={c.id} className="cc-row">
              <span className="cc-row-main">
                <strong>{c.name}</strong>
                <span>{c.provider === 'github' ? 'GitHub' : 'GitLab'} · {c.lastReceivedAt ? `last event ${relativeTime(c.lastReceivedAt)}` : 'nothing received yet'} · {c.repositories} {c.repositories === 1 ? 'repository' : 'repositories'} · secret {c.secretFingerprint}{c.isActive ? '' : ' · paused'}</span>
                <span className="eg-mono">{c.endpoint}</span>
              </span>
              <button type="button" className="sd-link-button" onClick={() => { if (window.confirm('Replace the secret? The webhook stops working until you paste the new one into the provider.')) void update(c, { rotate: true }); }}>Rotate secret</button>
              <button type="button" className="sd-link-button" onClick={() => void update(c, { isActive: !c.isActive })}>{c.isActive ? 'Pause' : 'Resume'}</button>
              <button type="button" className="sd-link-button" onClick={async () => {
                if (!window.confirm(`Delete the ${c.name} connection? Its webhook stops working immediately.`)) return;
                setError(null);
                try { await api.delete(`/engineering/scm/connections/${c.id}`); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
                invalidate('/engineering/');
              }}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
