/**
 * Engineering standards: scorecards across the catalogue, and the templates new services
 * start from.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, CircleSlash, Plus, XCircle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorState, Loading } from '../../components/States';
import { KIND_LABEL, ScoreBadge, TIER_LABEL, type Scorecard, type ServiceKind, type Tier } from '../../lib/engineering';
import { NewServiceDialog } from './Catalogue';
import '../../styles/command.css';
import '../../styles/service.css';
import '../../styles/engineering.css';

type Scorecards = {
  rules: { id: string; label: string; passing: number; applicable: number }[];
  average: number | null;
  items: { id: string; name: string; tier: string; kind: string; ownerName: string | null; mine: boolean; scorecard: Scorecard }[];
};
type Template = { id: string; name: string; description: string | null; kind: ServiceKind; tier: Tier; checklist: string[]; environments: string[] };

export default function Scorecards() {
  const data = useQuery<Scorecards>('/engineering/scorecards', (s) => api.get('/engineering/scorecards', s));
  const [mine, setMine] = useState(false);
  if (data.loading && !data.data) return <Loading label="Scoring the catalogue" rows={6} />;
  if (data.error && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />;
  const d = data.data!;
  const items = mine ? d.items.filter((i) => i.mine) : d.items;
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Engineering</p><h2>Scorecards</h2></div>
        <label className="sd-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Services I own</label>
      </header>
      <section className="cc-panel" aria-label="Across the catalogue">
        <header><h3>Across the catalogue</h3><span className="cc-meta">Average {d.average === null ? '—' : `${d.average}%`}</span></header>
        <ul className="sd-bars">
          {d.rules.map((r, n) => (
            <li key={r.id}>
              <span>{n + 1}. {r.label}</span>
              <span className={`sd-bar ${r.applicable && r.passing / r.applicable < 0.5 ? 'sd-bar-urgent' : ''}`} aria-hidden="true"><span style={{ width: `${r.applicable ? Math.max(2, (r.passing / r.applicable) * 100) : 0}%` }} /></span>
              <span className="sd-bar-value">{r.applicable ? `${r.passing}/${r.applicable}` : 'n/a'}</span>
            </li>
          ))}
        </ul>
      </section>
      {items.length === 0 ? <Empty title={mine ? 'You own no services' : 'No services'} description="Scorecards appear for every active service in the catalogue." /> : (
        <div className="sd-table-wrap">
          <table className="data-table sd-table eg-matrix">
            <thead>
              <tr>
                <th scope="col">Service</th><th scope="col">Score</th>
                {d.rules.map((r, n) => <th key={r.id} scope="col" className="eg-rule" title={r.label}><abbr title={r.label}>{n + 1}</abbr></th>)}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <th scope="row"><Link to={`/engineering/services/${i.id}`}>{i.name}</Link><span className="sd-sub">{i.ownerName ?? 'No owner'} · {i.tier}</span></th>
                  <td><ScoreBadge percent={i.scorecard.percent} level={i.scorecard.level} /></td>
                  {i.scorecard.rules.map((r) => (
                    <td key={r.id} className="eg-cell" title={r.applies ? (r.passed ? `${r.label}: passing` : `${r.label}: ${r.hint}`) : `${r.label}: does not apply`}>
                      {!r.applies ? <CircleSlash size={15} className="sd-muted" aria-label="Does not apply" /> : r.passed ? <CheckCircle2 size={15} className="eg-deploy-succeeded" aria-label="Passing" /> : <XCircle size={15} className="eg-deploy-failed" aria-label="Failing" />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Templates() {
  const { can } = useSession();
  const navigate = useNavigate();
  const list = useQuery<{ items: Template[] }>('/engineering/templates', (s) => api.get('/engineering/templates', s));
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [using, setUsing] = useState<string | null>(null);
  const manage = can('engineering.manage');
  return (
    <div className="module-page cc-page">
      <header className="cc-header">
        <div><p className="cc-eyebrow">Engineering</p><h2>Service templates</h2></div>
        <div className="cc-header-side">{manage ? <button type="button" className="primary-button" onClick={() => setEditing('new')}><Plus size={15} aria-hidden="true" /> New template</button> : null}</div>
      </header>
      {list.loading && !list.data ? <Loading rows={3} /> : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? <Empty title="No templates" description="A template sets the kind, tier, environments and onboarding checklist a new service starts with." />
        : (
          <div className="cc-grid">
            {list.data!.items.map((t) => (
              <section key={t.id} className="cc-panel" aria-label={t.name}>
                <header><h3>{t.name}</h3><span className="cc-meta">{KIND_LABEL[t.kind]} · {TIER_LABEL[t.tier]}</span></header>
                {t.description ? <p className="sd-panel-pad field-hint">{t.description}</p> : null}
                <p className="sd-panel-pad"><strong>Environments:</strong> {t.environments.length ? t.environments.join(', ') : 'none'}</p>
                <ol className="eg-steps">{t.checklist.map((c, n) => <li key={n}>{c}</li>)}</ol>
                <div className="sd-panel-pad sd-inline">
                  {manage ? <button type="button" className="ghost-button" onClick={() => setUsing(t.id)}>Create a service</button> : null}
                  {manage ? <button type="button" className="sd-link-button" onClick={() => setEditing(t)}>Edit</button> : null}
                </div>
              </section>
            ))}
          </div>
        )}
      {editing ? <TemplateDialog template={editing === 'new' ? null : editing} onClose={() => { setEditing(null); invalidate('/engineering/templates'); }} /> : null}
      {using ? <NewServiceDialog templateId={using} onClose={() => setUsing(null)} onCreated={(id) => { setUsing(null); invalidate('/engineering/'); navigate(`/engineering/services/${id}`); }} /> : null}
    </div>
  );
}

function TemplateDialog({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: template?.name ?? '', description: template?.description ?? '', kind: template?.kind ?? 'service', tier: template?.tier ?? 'standard',
    checklist: (template?.checklist ?? ['Assign an owner', 'Link the repository', 'Write a runbook', 'Connect monitoring']).join('\n'),
    environments: (template?.environments ?? ['production', 'staging']).join(', '),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog sd-dialog" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          const body = { name: f.name, description: f.description || null, kind: f.kind, tier: f.tier, checklist: f.checklist.split('\n'), environments: f.environments.split(',') };
          try {
            if (template) await api.put(`/engineering/templates/${template.id}`, body);
            else await api.post('/engineering/templates', body);
            onClose();
          } catch (err) { setError(err instanceof ApiError ? err.message : 'The template was not saved.'); }
        }}>
        <h3 id="tpl-title">{template ? `Edit ${template.name}` : 'New service template'}</h3>
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Name</span><input autoFocus required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Backend service" /></label>
          <label className="field sd-span-2"><span>When to use it</span><input maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label className="field"><span>Kind</span><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ServiceKind })}>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Tier</span><select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value as Tier })}>{Object.entries(TIER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field sd-span-2"><span>Environments (comma separated)</span><input value={f.environments} onChange={(e) => setF({ ...f, environments: e.target.value })} /></label>
          <label className="field sd-span-2"><span>Onboarding checklist (one step per line)</span><textarea rows={6} value={f.checklist} onChange={(e) => setF({ ...f, checklist: e.target.value })} /></label>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {template ? <button type="button" className="ghost-button" onClick={async () => {
            if (!window.confirm(`Delete the ${template.name} template? Services already created from it keep their checklists.`)) return;
            try { await api.delete(`/engineering/templates/${template.id}`); onClose(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Not deleted.'); }
          }}>Delete</button> : null}
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button">Save</button>
        </div>
      </form>
    </div>
  );
}

