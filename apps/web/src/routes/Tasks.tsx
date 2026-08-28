/**
 * Tasks and projects (blueprint 04).
 *
 * The board is a grid of status columns. Cards move by an explicit status control as
 * well as by drag, because the blueprint requires a tested keyboard alternative rather
 * than drag-only interaction.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FolderPlus, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading, FormError } from '../components/States';
import { relativeTime, titleCase } from '../lib/format';

type Project = {
  id: string;
  name: string;
  key: string;
  description: string;
  my_role: string | null;
  open_tasks: number;
  member_count: number;
};

type Task = {
  id: string;
  projectId: string;
  projectKey?: string;
  reference: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  dueAt: string | null;
  labels: string[];
  version: number;
};

type TaskDetail = Task & {
  comments: { id: string; body: string; created_at: string; author_name: string | null }[];
  activity: { field: string; before_value: string; after_value: string; created_at: string; actor_name: string | null }[];
  dependencies: { id: string; title: string; status: string }[];
};

const COLUMNS = ['todo', 'in_progress', 'review', 'blocked', 'done'] as const;

export default function Tasks() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);

  const projects = useQuery<{ items: Project[] }>('/projects', (signal) =>
    api.get('/projects', signal),
  );

  const activeProject = projectId ?? projects.data?.items[0]?.id ?? null;
  const listKey = activeProject ? `/tasks?projectId=${activeProject}&limit=200` : null;
  const tasks = useQuery<{ items: Task[] }>(listKey, (signal) =>
    api.get(`/tasks?projectId=${activeProject}&limit=200`, signal),
  );

  const detailKey = taskId ? `/tasks/${taskId}` : null;
  const detail = useQuery<TaskDetail>(detailKey, (signal) => api.get(`/tasks/${taskId}`, signal));

  const move = useMutation(
    async ({ task, status }: { task: Task; status: string }) =>
      api.patch(`/tasks/${task.id}`, { status }, { ifMatch: task.version }),
    { invalidates: ['/tasks'] },
  );

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Tasks</h2>
          <p>Work assigned across your projects.</p>
        </div>
        <div className="header-controls">
          <label className="visually-hidden" htmlFor="project-select">Project</label>
          <select
            id="project-select"
            value={activeProject ?? ''}
            onChange={(event) => {
              setProjectId(event.target.value);
              navigate('/tasks');
            }}
          >
            {(projects.data?.items ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} ({project.key})
              </option>
            ))}
          </select>
          <button type="button" className="ghost-button" onClick={() => setCreatingProject(true)}>
            <FolderPlus size={15} aria-hidden="true" /> New project
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => setCreating(true)}
            disabled={!activeProject}
          >
            <Plus size={15} aria-hidden="true" /> New task
          </button>
        </div>
      </header>

      {projects.loading ? (
        <Loading label="Loading projects" />
      ) : projects.error ? (
        <ErrorState error={projects.error} onRetry={projects.reload} />
      ) : (projects.data?.items.length ?? 0) === 0 ? (
        <Empty
          title="No projects yet"
          description="Projects group tasks and control who can see them."
          action={
            <button type="button" className="primary-button" onClick={() => setCreatingProject(true)}>
              <FolderPlus size={15} aria-hidden="true" /> Create a project
            </button>
          }
        />
      ) : (
        <AsyncSection query={tasks}>
          {(data) => (
            <div className="task-board" role="list">
              {COLUMNS.map((column) => {
                const columnTasks = data.items.filter((task) => task.status === column);
                return (
                  <section key={column} className="board-column" role="listitem" aria-label={titleCase(column)}>
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
                              onClick={() => navigate(`/tasks/${task.id}`)}
                            >
                              <span className={`priority-dot priority-${task.priority}`} aria-hidden="true" />
                              <strong>{task.title}</strong>
                              <span className="task-meta">
                                {task.reference}
                                {task.assigneeName ? ` · ${task.assigneeName}` : ''}
                                {task.dueAt ? ` · due ${relativeTime(task.dueAt)}` : ''}
                              </span>
                            </button>

                            {/* Keyboard-operable alternative to dragging between columns. */}
                            <label className="visually-hidden" htmlFor={`status-${task.id}`}>
                              Status for {task.title}
                            </label>
                            <select
                              id={`status-${task.id}`}
                              className="task-status-select"
                              value={task.status}
                              onChange={(event) =>
                                void move.mutate({ task, status: event.target.value })
                              }
                            >
                              {COLUMNS.map((option) => (
                                <option key={option} value={option}>
                                  {titleCase(option)}
                                </option>
                              ))}
                            </select>
                          </article>
                        </li>
                      ))}
                      {columnTasks.length === 0 ? (
                        <li className="board-empty">Nothing here</li>
                      ) : null}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </AsyncSection>
      )}

      {move.error ? (
        <p className="field-error" role="alert">
          {move.error.message}
          {'isConflict' in move.error && move.error.isConflict
            ? ' Reload to see the current state before retrying.'
            : ''}
        </p>
      ) : null}

      {taskId ? (
        <TaskDialog
          detail={detail}
          onClose={() => navigate('/tasks')}
        />
      ) : null}

      {creatingProject ? (
        <CreateProjectDialog
          onClose={() => setCreatingProject(false)}
          onCreated={(id) => {
            setCreatingProject(false);
            invalidate('/projects');
            setProjectId(id);
          }}
        />
      ) : null}

      {creating && activeProject ? (
        <CreateTaskDialog
          projectId={activeProject}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            invalidate('/tasks');
          }}
        />
      ) : null}
    </div>
  );
}

function TaskDialog({
  detail,
  onClose,
}: {
  detail: ReturnType<typeof useQuery<TaskDetail>>;
  onClose: () => void;
}) {
  const [comment, setComment] = useState('');

  const addComment = useMutation(
    async () => api.post(`/tasks/${detail.data!.id}/comments`, { body: comment }),
    {
      invalidates: ['/tasks'],
      onSuccess: () => {
        setComment('');
        detail.reload();
      },
    },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        {detail.loading ? (
          <Loading label="Loading task" />
        ) : detail.error ? (
          <ErrorState error={detail.error} onRetry={detail.reload} />
        ) : detail.data ? (
          <>
            <h3 id="task-dialog-title">{detail.data.title}</h3>
            <p className="task-meta">
              {detail.data.reference} · {titleCase(detail.data.status)} ·{' '}
              {titleCase(detail.data.priority)} priority
              {detail.data.assigneeName ? ` · ${detail.data.assigneeName}` : ' · Unassigned'}
            </p>

            {detail.data.description ? <p>{detail.data.description}</p> : null}

            {detail.data.dependencies.length > 0 ? (
              <section>
                <h4>Depends on</h4>
                <ul className="dependency-list">
                  {detail.data.dependencies.map((dependency) => (
                    <li key={dependency.id}>
                      {dependency.title} — {titleCase(dependency.status)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h4>Comments</h4>
              {detail.data.comments.length === 0 ? (
                <p className="panel-empty">No comments yet.</p>
              ) : (
                <ul className="comment-list">
                  {detail.data.comments.map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.author_name ?? 'Unknown'}</strong>
                      <time dateTime={entry.created_at}>{relativeTime(entry.created_at)}</time>
                      <p>{entry.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (comment.trim()) void addComment.mutate();
                }}
              >
                <label className="visually-hidden" htmlFor="task-comment">Add a comment</label>
                <textarea
                  id="task-comment"
                  rows={3}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Add a comment…"
                />
                <button type="submit" className="primary-button" disabled={addComment.pending}>
                  {addComment.pending ? 'Posting…' : 'Comment'}
                </button>
              </form>
            </section>

            <section>
              <h4>History</h4>
              <ul className="activity-list">
                {detail.data.activity.map((entry, index) => (
                  <li key={`${entry.created_at}-${index}`}>
                    <span>
                      {entry.actor_name ?? 'Someone'} changed {titleCase(entry.field)} from{' '}
                      <em>{entry.before_value || 'empty'}</em> to <em>{entry.after_value || 'empty'}</em>
                    </span>
                    <time dateTime={entry.created_at}>{relativeTime(entry.created_at)}</time>
                  </li>
                ))}
              </ul>
            </section>

            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={onClose}>Close</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CreateTaskDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [assigneeId, setAssigneeId] = useState('');

  const people = useQuery<{ items: { id: string; displayName: string }[] }>(
    '/users?limit=100',
    (signal) => api.get('/users?limit=100', signal),
  );

  const create = useMutation(
    async () =>
      api.post(`/projects/${projectId}/tasks`, {
        title,
        description,
        priority,
        assigneeId: assigneeId || null,
      }),
    { invalidates: ['/tasks'], onSuccess: onCreated },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="new-task-title">New task</h3>
        <FormError error={create.error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="task-title">Title</label>
            <input
              id="task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="task-description">Description</label>
            <textarea
              id="task-description"
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="task-priority">Priority</label>
              <select
                id="task-priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              >
                {['low', 'medium', 'high', 'urgent'].map((option) => (
                  <option key={option} value={option}>{titleCase(option)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="task-assignee">Assign to</label>
              <select
                id="task-assignee"
                value={assigneeId}
                onChange={(event) => setAssigneeId(event.target.value)}
              >
                <option value="">Unassigned</option>
                {(people.data?.items ?? []).map((person) => (
                  <option key={person.id} value={person.id}>{person.displayName}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Creating a project also creates its membership, which is what governs who can see
 * the tasks inside it.
 */
function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const people = useQuery<{ items: { id: string; displayName: string }[] }>(
    '/users?limit=100&status=active',
    (signal) => api.get('/users?limit=100&status=active', signal),
  );

  const create = useMutation(
    async () =>
      api.post<{ id: string }>('/projects', {
        name,
        key: key.toUpperCase(),
        description: description || undefined,
        memberIds,
      }),
    { invalidates: ['/projects'], onSuccess: (project) => onCreated(project.id) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="project-title">New project</h3>

        <FormError error={create.error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                // Suggest a key from the name, but let it be overridden.
                if (!key) {
                  setKey(
                    event.target.value
                      .replace(/[^a-zA-Z0-9 ]/g, '')
                      .split(/\s+/)
                      .map((word) => word[0] ?? '')
                      .join('')
                      .toUpperCase()
                      .slice(0, 6),
                  );
                }
              }}
              required
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="project-key">Key</label>
            <input
              id="project-key"
              value={key}
              onChange={(event) => setKey(event.target.value.toUpperCase())}
              required
              maxLength={10}
            />
            <p className="field-hint">
              2–10 uppercase letters or digits. Task references look like {key || 'KEY'}-1.
            </p>
          </div>

          <div className="field">
            <label htmlFor="project-description">Description</label>
            <textarea
              id="project-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <fieldset className="field">
            <legend>Members</legend>
            <p className="field-hint">
              Only members can see this project's tasks. You are added automatically.
              {(people.data?.items.length ?? 0) >= 100
                ? ' Showing the first 100 active accounts.'
                : ''}
            </p>
            <div className="attendee-picker">
              {(people.data?.items ?? []).map((person) => (
                <label key={person.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={memberIds.includes(person.id)}
                    onChange={(event) =>
                      setMemberIds((current) =>
                        event.target.checked
                          ? [...current, person.id]
                          : current.filter((id) => id !== person.id),
                      )
                    }
                  />
                  {person.displayName}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
