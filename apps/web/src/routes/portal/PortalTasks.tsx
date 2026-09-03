/**
 * The work being done for this client.
 *
 * The same board a colleague sees, minus everything that changes anything: no status
 * control on a card, no new-task button, no comments. A client watching progress needs
 * the shape of the work, not the ability to reorganise it — and the discussion on a task
 * is colleagues talking to each other about the client, which is not theirs to read.
 *
 * Scoped by project rather than by individual shares. A project belongs to a client, so
 * every task in it is work being done for them; sharing them one at a time would mean the
 * first task someone forgot to share looked to the client like work that never happened.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { AsyncSection, Empty, ErrorState, Loading } from '../../components/States';
import { TaskPriority } from '../../components/TaskPriority';
import { formatDate, relativeTime, titleCase } from '../../lib/format';

/** The same columns, in the same order, as the workspace board. */
const COLUMNS = ['todo', 'in_progress', 'review', 'blocked', 'done'] as const;

type Project = {
  id: string; name: string; key: string; status: string;
  description: string | null; starts_on: string | null; ends_on: string | null;
};

type Task = {
  id: string;
  projectId: string;
  projectKey?: string;
  reference: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignees: { id: string; name: string }[];
  dueAt: string | null;
  labels: string[];
};

export function PortalTasks() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const projects = useQuery<{ items: Project[] }>('/portal/projects', (signal) =>
    api.get('/portal/projects', signal),
  );

  const activeProject = projectId ?? projects.data?.items[0]?.id ?? null;
  const listKey = activeProject ? `/portal/projects/${activeProject}/tasks` : null;
  const tasks = useQuery<{ items: Task[] }>(listKey, (signal) =>
    api.get(`/portal/projects/${activeProject}/tasks`, signal),
  );

  const project = projects.data?.items.find((p) => p.id === activeProject) ?? null;

  return (
    <>
      <header className="portal-head portal-head-row">
        <div>
          <h1>Work</h1>
          <p>
            {project
              ? `Progress on ${project.name}.`
              : 'Progress on the work we are doing for you.'}
          </p>
        </div>

        {/* Only worth a selector when there is a choice to make. */}
        {(projects.data?.items.length ?? 0) > 1 ? (
          <div className="header-controls">
            <label className="visually-hidden" htmlFor="portal-project">Project</label>
            <select
              id="portal-project"
              value={activeProject ?? ''}
              onChange={(event) => {
                setProjectId(event.target.value);
                setOpenTaskId(null);
              }}
            >
              {(projects.data?.items ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.key})
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      {projects.loading ? (
        <Loading label="Loading projects" />
      ) : projects.error ? (
        <ErrorState error={projects.error} onRetry={projects.reload} />
      ) : (projects.data?.items.length ?? 0) === 0 ? (
        <Empty
          title="No projects yet"
          description="When we start a project for you, the work appears here."
        />
      ) : (
        <AsyncSection query={tasks}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty
                title="Nothing on the board yet"
                description="Tasks appear here as the team plans the work."
              />
            ) : (
              <div className="task-board" role="list">
                {COLUMNS.map((column) => {
                  const columnTasks = data.items.filter((task) => task.status === column);
                  return (
                    <section
                      key={column}
                      className="board-column"
                      role="listitem"
                      aria-label={titleCase(column)}
                    >
                      <header>
                        <h3>{titleCase(column)}</h3>
                        <span>{columnTasks.length}</span>
                      </header>
                      <ul>
                        {columnTasks.map((task) => (
                          <li key={task.id}>
                            <article className="task-card">
                              <button
                                type="button"
                                className="task-card-open"
                                onClick={() => setOpenTaskId(task.id)}
                              >
                                <TaskPriority priority={task.priority} />
                                <strong>{task.title}</strong>
                                <span className="task-meta">
                                  {task.reference}
                                  {(task.assignees ?? []).length === 0
                                    ? ''
                                    : ` · ${task.assignees.map((p) => p.name).join(', ')}`}
                                  {task.dueAt ? ` · due ${relativeTime(task.dueAt)}` : ''}
                                </span>
                              </button>
                            </article>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )
          }
        </AsyncSection>
      )}

      {openTaskId ? (
        <PortalTaskDialog taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
      ) : null}
    </>
  );
}

type TaskDetail = Task & { projectName: string };

/** A task, to read. Nothing here changes anything. */
function PortalTaskDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .get<TaskDetail>(`/portal/tasks/${taskId}`)
      .then((result) => { if (live) setTask(result); })
      .catch(() => { if (live) setError('That task could not be loaded.'); });
    return () => { live = false; };
  }, [taskId]);

  // Escape closes it, as everywhere else in the product.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-label="Task"
        onClick={(event) => event.stopPropagation()}
      >
        {error ? (
          <p className="field-error">{error}</p>
        ) : !task ? (
          <p className="field-hint">Loading…</p>
        ) : (
          <>
            <h3>{task.title}</h3>
            <p className="task-meta">
              {task.reference} · {task.projectName}
            </p>

            <dl className="detail-list">
              <div>
                <dt>Status</dt>
                <dd><span className="status-tag">{titleCase(task.status)}</span></dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd><TaskPriority priority={task.priority} /></dd>
              </div>
              <div>
                <dt>Working on it</dt>
                <dd>
                  {task.assignees.length === 0
                    ? 'Not started'
                    : task.assignees.map((p) => p.name).join(', ')}
                </dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd>{task.dueAt ? formatDate(task.dueAt) : 'No date set'}</dd>
              </div>
            </dl>

            {task.description ? (
              <section className="task-block">
                <h4>Details</h4>
                <p className="message-text">{task.description}</p>
              </section>
            ) : null}

            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
