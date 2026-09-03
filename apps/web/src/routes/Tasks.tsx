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
import { api, ApiError } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading, FormError } from '../components/States';
import { TaskPriority } from '../components/TaskPriority';
import { formatDate, initials, relativeTime, titleCase } from '../lib/format';
import { PeoplePicker } from '../components/PeoplePicker';
import { useSession } from '../lib/session';
import { ShareWith } from '../components/ShareWith';

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
  /** Everyone on the task. assigneeId is just the first of these. */
  assignees: { id: string; name: string }[];
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

/*
 * The status tag's colour. Every status previously used the same "invited" yellow, so a
 * finished task and a blocked one looked identical in the one place people check.
 */
const STATUS_TAG: Record<string, string> = {
  todo: 'status-pending',
  in_progress: 'status-invited',
  review: 'status-invited',
  blocked: 'status-error',
  done: 'status-active',
};

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
  const listKey = activeProject ? `/tasks?projectId=${activeProject}&limit=100` : null;
  const tasks = useQuery<{ items: Task[] }>(listKey, (signal) =>
    api.get(`/tasks?projectId=${activeProject}&limit=100`, signal),
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
                              <TaskPriority priority={task.priority} />
                              <strong>{task.title}</strong>
                              <span className="task-meta">
                                {task.reference}
                                {/* Everyone on it, and "Unassigned" said out loud rather
                                    than left as a gap - an unowned task is the one that
                                    needs picking up. */}
                                {(task.assignees ?? []).length === 0
                                  ? ' · Unassigned'
                                  : ` · ${task.assignees.map((p) => p.name).join(', ')}`}
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
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
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
            <header className="task-detail-head">
              <div>
                <span className="task-detail-ref">{detail.data.reference}</span>
                <h3 id="task-dialog-title" className="task-detail-title">{detail.data.title}</h3>
              </div>
              <div className="table-actions">
                <button type="button" className="ghost-button" onClick={() => setSharing(true)}>
                  Share
                </button>
                <button type="button" className="ghost-button" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button type="button" className="ghost-button" onClick={onClose}>Close</button>
              </div>
            </header>

            <div className="task-detail-body">
              <div className="task-detail-main">
                {detail.data.description ? (
                  <p className="message-text">{detail.data.description}</p>
                ) : (
                  <p className="field-hint task-detail-empty">No description yet.</p>
                )}

                {detail.data.dependencies.length > 0 ? (
                  <section className="task-block">
                    <h4>Blocked by</h4>
                    <ul className="dependency-list">
                      {detail.data.dependencies.map((dependency) => (
                        <li key={dependency.id}>
                          {dependency.title} — {titleCase(dependency.status)}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section className="task-block">
                  <h4>
                    Comments
                    {detail.data.comments.length > 0 ? (
                      <span className="count-badge">{detail.data.comments.length}</span>
                    ) : null}
                  </h4>

                  {detail.data.comments.length > 0 ? (
                    <ul className="comment-list">
                      {detail.data.comments.map((entry) => (
                        <li key={entry.id}>
                          <span className="avatar avatar-sm" aria-hidden="true">
                            {initials(entry.author_name ?? '?')}
                          </span>
                          <div className="comment-body">
                            <p className="comment-meta">
                              <strong>{entry.author_name ?? 'Unknown'}</strong>
                              <time dateTime={entry.created_at}>{relativeTime(entry.created_at)}</time>
                            </p>
                            <p className="comment-text">{entry.body}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {/* The composer, not a heading over emptiness: with no comments the
                      only useful thing on screen is the box for writing the first one. */}
                  <form
                    className="comment-form"
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
                      placeholder={
                        detail.data.comments.length === 0
                          ? 'No comments yet — start the thread.'
                          : 'Add a comment…'
                      }
                    />
                    <div className="comment-actions">
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={addComment.pending || !comment.trim()}
                      >
                        {addComment.pending ? 'Posting…' : 'Comment'}
                      </button>
                    </div>
                  </form>
                </section>

                {/* Only when something has actually happened. A "History" heading over an
                    empty list reads as a broken panel. */}
                {detail.data.activity.length > 0 ? (
                  <section className="task-block">
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
                ) : null}
              </div>

              {/* The facts rail: the answers people open a task to check, in one place
                  rather than run together in a single line of metadata. */}
              <dl className="task-facts">
                <div className="task-fact">
                  <dt>Status</dt>
                  <dd>
                    <span className={`status-tag ${STATUS_TAG[detail.data.status] ?? 'status-pending'}`}>
                      {titleCase(detail.data.status)}
                    </span>
                  </dd>
                </div>
                <div className="task-fact">
                  <dt>Priority</dt>
                  <dd className={`priority-value task-prio-${detail.data.priority}`}>
                    {titleCase(detail.data.priority)}
                  </dd>
                </div>
                <div className="task-fact">
                  <dt>Assigned to</dt>
                  <dd className="assignee-stack">
                    {(detail.data.assignees ?? []).length === 0 ? (
                      <span className="field-hint">Nobody yet</span>
                    ) : (
                      detail.data.assignees!.map((person) => (
                        <span key={person.id} className="chip">{person.name}</span>
                      ))
                    )}
                  </dd>
                </div>
                {detail.data.dueAt ? (
                  <div className="task-fact">
                    <dt>Due</dt>
                    <dd>{formatDate(detail.data.dueAt)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>

            {sharing ? (
              <ShareWith
                resourceType="task"
                resourceId={detail.data.id}
                resourceName={detail.data.reference}
                onClose={() => setSharing(false)}
              />
            ) : null}

            {editing ? (
              <EditTaskDialog
                task={detail.data}
                onClose={() => setEditing(false)}
                onSaved={() => { setEditing(false); detail.reload(); invalidate('/tasks'); }}
              />
            ) : null}
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
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [dueAt, setDueAt] = useState('');
  const { can } = useSession();
  const canAssign = can('task.assign');

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
        assigneeIds,
        // Sent as an instant because the column is a timestamp; the picker only offers
        // a day, so end of that day is the honest reading of "due on the 4th".
        dueAt: dueAt ? new Date(`${dueAt}T23:59:59`).toISOString() : null,
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
              <label htmlFor="task-due">Due date</label>
              <input
                id="task-due"
                type="date"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
              />
            </div>
          </div>

          {/* The same picker the edit dialog uses. A single select here meant a task with
              three people on it had to be created, saved, then reopened and edited - and
              the due date could not be set at all until afterwards.

              Hidden without `task.assign`: deciding who does a piece of work is a
              separate permission from writing it down, and the server refuses the
              assignment either way. */}
          {canAssign ? (
            <PeoplePicker
              label="Assign to"
              people={people.data?.items ?? []}
              selected={assigneeIds}
              onChange={setAssigneeIds}
              emptyHint="Nobody yet — it will show on the board as unassigned."
            />
          ) : null}
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
  const { can } = useSession();
  const canChooseMembers = can('project.manage');

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

          {/*
            * Membership is who can see the project, and choosing that is a separate
            * permission from starting one. Anyone without it is not shown the picker:
            * the server ignores members they name, so offering the control would be
            * offering something that silently does nothing.
            */}
          {canChooseMembers ? (
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
          ) : (
            <p className="field-hint">
              You will be the only member. Ask an administrator to add anyone else.
            </p>
          )}

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


/**
 * Editing a task.
 *
 * Assignment is a set, not a person: work is shared, and forcing one name onto a task
 * means the other people doing it are invisible to everyone looking at the board.
 *
 * The version is sent back with the change, so two people editing the same task at once
 * get a conflict rather than one silently overwriting the other.
 */
function EditTaskDialog({
  task,
  onClose,
  onSaved,
}: {
  task: TaskDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [status, setStatus] = useState(task.status);
  const [priority, setPriority] = useState(task.priority);
  const [dueAt, setDueAt] = useState(task.dueAt ? String(task.dueAt).slice(0, 10) : '');
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    (task.assignees ?? []).map((person) => person.id),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const people = useQuery<{ items: { id: string; display_name: string; email_display: string }[] }>(
    '/users?limit=100',
    (signal) => api.get('/users?limit=100', signal),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch(
        `/tasks/${task.id}`,
        {
          title,
          description,
          status,
          priority,
          dueAt: dueAt ? new Date(`${dueAt}T17:00:00`).toISOString() : null,
          assigneeIds,
        },
        { ifMatch: task.version },
      );
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 412
            ? 'Someone else changed this task while you were editing. Close and reopen it.'
            : err.message
          : 'That could not be saved',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form
        className="dialog dialog-wide"
        role="dialog"
        aria-label={`Edit ${task.reference}`}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h3>Edit {task.reference}</h3>

        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'].map((value) => (
                <option key={value} value={value}>{titleCase(value)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {['low', 'medium', 'high', 'urgent'].map((value) => (
                <option key={value} value={value}>{titleCase(value)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Due date</span>
            <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </label>
        </div>

        <PeoplePicker
          label="Assigned to"
          people={people.data?.items ?? []}
          selected={assigneeIds}
          onChange={setAssigneeIds}
          emptyHint="Nobody assigned — it will show on the board as unassigned."
        />

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
