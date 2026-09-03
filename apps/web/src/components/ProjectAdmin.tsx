/**
 * Managing projects.
 *
 * The key is immutable, like a leave type's: task references are built from it
 * (`WEB-142`) and those appear in commit messages, chat and email long after the task
 * closes. Renaming is free; re-keying would orphan every reference.
 *
 * "Delete" archives. Tasks, invoices and time all point at a project, so removing the
 * row would take a year of work with it — archiving hides it from the pickers while
 * every reference still resolves, which is what deleting is nearly always meant to do.
 */
import { useState } from 'react';
import { ProjectMembers } from './ProjectMembers';
import { useSession } from '../lib/session';
import { api, ApiError } from '../lib/api';
import { invalidate, useQuery } from '../lib/query';
import { useNotify } from '../lib/notify';

type Project = {
  id: string;
  name: string;
  key: string;
  description: string;
  status: 'active' | 'on_hold' | 'archived';
  client_org_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
};

const STATUS_TONE: Record<Project['status'], string> = {
  active: 'status-active',
  on_hold: 'status-invited',
  archived: 'status-suspended',
};

export function ProjectAdmin() {
  const { notify } = useNotify();
  const [editing, setEditing] = useState<Project | null>(null);

  const projects = useQuery<{ items: Project[] }>('/projects', (signal) =>
    api.get('/projects', signal),
  );

  async function archive(project: Project) {
    try {
      await api.delete(`/projects/${project.id}`);
      notify({ severity: 'success', title: 'Project archived', body: project.name });
      invalidate('/projects');
      projects.reload();
    } catch (err) {
      notify({
        severity: 'warning',
        title: 'That project could not be archived',
        // The server refuses while tasks are open and says how many.
        body: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  return (
    <section className="panel" aria-labelledby="projects-heading">
      <header className="panel-header">
        <span className="panel-title" id="projects-heading">Projects</span>
      </header>

      {(projects.data?.items ?? []).length === 0 ? (
        <p className="field-hint">No projects yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>Key</th><th>Dates</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {projects.data!.items.map((project) => (
                <tr key={project.id} style={{ opacity: project.status === 'archived' ? 0.55 : 1 }}>
                  <td><strong>{project.name}</strong></td>
                  <td><code>{project.key}</code></td>
                  <td>
                    {project.starts_on || project.ends_on
                      ? `${project.starts_on?.slice(0, 10) ?? '—'} → ${project.ends_on?.slice(0, 10) ?? '—'}`
                      : '—'}
                  </td>
                  <td>
                    <span className={`status-tag ${STATUS_TONE[project.status]}`}>
                      {project.status === 'on_hold' ? 'On hold'
                        : project.status.charAt(0).toUpperCase() + project.status.slice(1)}
                    </span>
                  </td>
                  <td className="table-actions">
                    <button type="button" className="ghost-button" onClick={() => setEditing(project)}>
                      Edit
                    </button>
                    {project.status !== 'archived' ? (
                      <button type="button" className="ghost-button" onClick={() => void archive(project)}>
                        Archive
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <EditProject
          project={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate('/projects'); projects.reload(); }}
        />
      ) : null}
    </section>
  );
}

function EditProject({
  project, onClose, onSaved,
}: { project: Project; onClose: () => void; onSaved: () => void }) {
  const { can } = useSession();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [status, setStatus] = useState(project.status);
  const [clientOrgId, setClientOrgId] = useState(project.client_org_id ?? '');
  const [startsOn, setStartsOn] = useState(project.starts_on?.slice(0, 10) ?? '');
  const [endsOn, setEndsOn] = useState(project.ends_on?.slice(0, 10) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const clients = useQuery<{ items: { id: string; name: string }[] }>(
    '/external/organizations?kind=client',
    (signal) => api.get('/external/organizations?kind=client', signal),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/projects/${project.id}`, {
        name,
        description,
        status,
        clientOrgId: clientOrgId || null,
        startsOn: startsOn || null,
        endsOn: endsOn || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={`Edit ${project.name}`}
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Edit project</h3>

        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>

        <label className="field">
          <span>Key</span>
          <input value={project.key} disabled readOnly />
          <span className="field-hint">
            Fixed. Task references like {project.key}-142 are built from it and appear
            outside this system.
          </span>
        </label>

        <label className="field">
          <span>Description</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as Project['status'])}>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="field">
            <span>Client</span>
            <select value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)}>
              <option value="">Internal — no client</option>
              {(clients.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <span className="field-hint">Invoices can be grouped by project for this client.</span>
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Starts</span>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </label>
          <label className="field">
            <span>Ends</span>
            <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </label>
        </div>

        {/* Membership saves on its own rather than with the form: adding somebody is a
            separate decision from renaming the project, and losing one because you
            cancelled the other would be worse than two save points. */}
        <ProjectMembers projectId={project.id} canManage={can('project.manage')} />

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
