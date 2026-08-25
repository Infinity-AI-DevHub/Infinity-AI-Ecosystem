/**
 * Tasks and projects domain (blueprint 04).
 * Project membership governs task visibility; every field change is recorded in the
 * task activity history.
 */
import { many, one, pool, transaction, isPgError, PG } from '../core/db.js';
import { conflict, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { publish } from '../core/realtime.js';
import * as searchIndex from './search.js';

export type ProjectRow = {
  id: string;
  company_id: string;
  name: string;
  key: string;
  description: string;
  status: string;
  owner_id: string | null;
};

export type TaskRow = {
  id: string;
  company_id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  reporter_id: string | null;
  due_at: Date | null;
  start_at: Date | null;
  labels: string[];
  checklist: unknown;
  position: number;
  version: number;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function projectMembership(projectId: string, userId: string) {
  return one<{ role: string }>(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId],
  );
}

async function requireProject(actor: Actor, projectId: string, capability: string) {
  const project = await one<ProjectRow>('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [
    projectId,
    actor.companyId,
  ]);
  if (!project) throw notFound('Project not found');
  const member = await projectMembership(projectId, actor.userId);
  await authorize({
    actor,
    capability,
    resourceType: 'project',
    resourceId: projectId,
    membership: Boolean(member),
  });
  return { project, member };
}

export async function createProject(
  actor: Actor,
  input: { name: string; key: string; description?: string; memberIds?: string[] },
): Promise<ProjectRow> {
  await authorize({ actor, capability: 'project.create', resourceless: true });
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
    throw unprocessable('Project key is not valid', [
      { field: 'key', message: 'Use 2-10 uppercase letters or digits, starting with a letter' },
    ]);
  }
  return transaction(async (tx) => {
    let project: ProjectRow;
    try {
      const res = await tx.query<ProjectRow>(
        `INSERT INTO projects (company_id, name, key, description, owner_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [actor.companyId, input.name.trim(), key, input.description ?? '', actor.userId],
      );
      project = res.rows[0]!;
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) throw conflict('A project with that key already exists');
      throw err;
    }
    await tx.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')`, [
      project.id,
      actor.userId,
    ]);
    for (const userId of (input.memberIds ?? []).filter((id) => id !== actor.userId)) {
      await tx.query(
        `INSERT INTO project_members (project_id, user_id) SELECT $1, id FROM users
          WHERE id = $2 AND company_id = $3 AND status = 'active' ON CONFLICT DO NOTHING`,
        [project.id, userId, actor.companyId],
      );
    }
    await auditFromActor(actor, 'project.create', { resourceType: 'project', resourceId: project.id }, tx);
    return project;
  });
}

export async function listProjects(actor: Actor) {
  return many(
    `SELECT p.*, pm.role AS my_role,
            (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') AS open_tasks,
            (SELECT count(*)::int FROM project_members m WHERE m.project_id = p.id) AS member_count
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.company_id = $1
        AND p.status = 'active'
        AND (pm.user_id IS NOT NULL OR $3)
      ORDER BY p.name`,
    [actor.companyId, actor.userId, actor.accessLevel === 'admin' || actor.accessLevel === 'super_admin'],
  );
}

export async function createTask(
  actor: Actor,
  projectId: string,
  input: {
    title: string;
    description?: string;
    assigneeId?: string | null;
    priority?: string;
    dueAt?: string | null;
    labels?: string[];
    dependsOn?: string[];
  },
  correlationId: string,
): Promise<TaskRow> {
  await requireProject(actor, projectId, 'task.create');
  if (input.assigneeId) await assertCompanyMember(actor.companyId, input.assigneeId);

  const task = await transaction(async (tx) => {
    const numberRes = await tx.query<{ number: number }>(
      'SELECT COALESCE(max(number), 0) + 1 AS number FROM tasks WHERE project_id = $1 FOR UPDATE',
      [projectId],
    );
    const res = await tx.query<TaskRow>(
      `INSERT INTO tasks
         (company_id, project_id, number, title, description, priority, assignee_id, reporter_id, due_at, labels)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        actor.companyId,
        projectId,
        numberRes.rows[0]?.number ?? 1,
        input.title.trim(),
        input.description ?? '',
        input.priority ?? 'medium',
        input.assigneeId ?? null,
        actor.userId,
        input.dueAt ? new Date(input.dueAt) : null,
        input.labels ?? [],
      ],
    );
    const created = res.rows[0]!;

    for (const dependencyId of input.dependsOn ?? []) {
      await assertNoDependencyCycle(created.id, dependencyId);
      await tx.query(
        'INSERT INTO task_dependencies (task_id, depends_on) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [created.id, dependencyId],
      );
    }
    await tx.query('INSERT INTO task_watchers (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      created.id,
      actor.userId,
    ]);
    await auditFromActor(
      actor,
      'task.create',
      { resourceType: 'task', resourceId: created.id, correlationId },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'task.created',
        actorId: actor.userId,
        correlationId,
        payload: { taskId: created.id, projectId, assigneeId: created.assignee_id },
      },
      tx,
    );
    return created;
  });

  publish(`project:${projectId}`, 'task.created', { task: publicTask(task) });
  return task;
}

async function assertCompanyMember(companyId: string, userId: string): Promise<void> {
  const row = await one(`SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'`, [
    userId,
    companyId,
  ]);
  if (!row) {
    throw unprocessable('Assignee is not an active account in this company', [
      { field: 'assigneeId', message: 'Choose an active colleague' },
    ]);
  }
}

/** Prevents a dependency graph that can never complete. */
async function assertNoDependencyCycle(taskId: string, dependsOn: string): Promise<void> {
  if (taskId === dependsOn) throw unprocessable('A task cannot depend on itself', []);
  const cycle = await one<{ exists: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT depends_on FROM task_dependencies WHERE task_id = $2
       UNION
       SELECT d.depends_on FROM task_dependencies d JOIN chain c ON d.task_id = c.depends_on
     )
     SELECT true AS exists FROM chain WHERE depends_on = $1 LIMIT 1`,
    [taskId, dependsOn],
  );
  if (cycle) throw conflict('That dependency would create a cycle');
}

export async function listTasks(
  actor: Actor,
  filters: { projectId?: string; assigneeId?: string; status?: string; limit: number },
) {
  if (filters.projectId) await requireProject(actor, filters.projectId, 'task.update');
  return many<TaskRow & { assignee_name: string | null; project_key: string }>(
    `SELECT t.*, u.display_name AS assignee_name, p.key AS project_key
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.company_id = $1
        AND ($3::uuid IS NULL OR t.project_id = $3)
        AND ($4::uuid IS NULL OR t.assignee_id = $4)
        AND ($5::text IS NULL OR t.status = $5)
      ORDER BY t.position, t.created_at DESC
      LIMIT $6`,
    [
      actor.companyId,
      actor.userId,
      filters.projectId ?? null,
      filters.assigneeId ?? null,
      filters.status ?? null,
      filters.limit,
    ],
  ).then((rows) => rows.map(publicTask));
}

export async function updateTask(
  actor: Actor,
  taskId: string,
  input: Partial<{
    title: string;
    description: string;
    status: string;
    priority: string;
    assigneeId: string | null;
    dueAt: string | null;
    labels: string[];
    position: number;
  }>,
  expectedVersion: number | null,
  correlationId: string,
): Promise<TaskRow> {
  const existing = await one<TaskRow>('SELECT * FROM tasks WHERE id = $1 AND company_id = $2', [
    taskId,
    actor.companyId,
  ]);
  if (!existing) throw notFound('Task not found');
  await requireProject(actor, existing.project_id, input.assigneeId !== undefined ? 'task.assign' : 'task.update');
  if (expectedVersion !== null && existing.version !== expectedVersion) throw preconditionFailed();
  if (input.assigneeId) await assertCompanyMember(actor.companyId, input.assigneeId);

  // A task cannot be completed while something it depends on is still open.
  if (input.status === 'done') {
    const blocking = await one<{ title: string }>(
      `SELECT b.title FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on
        WHERE d.task_id = $1 AND b.status NOT IN ('done','cancelled') LIMIT 1`,
      [taskId],
    );
    if (blocking) throw conflict(`Blocked by an open dependency: ${blocking.title}`);
  }

  const updated = await transaction(async (tx) => {
    const res = await tx.query<TaskRow>(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         status = COALESCE($5, status),
         priority = COALESCE($6, priority),
         assignee_id = CASE WHEN $7::boolean THEN $8 ELSE assignee_id END,
         due_at = CASE WHEN $9::boolean THEN $10 ELSE due_at END,
         labels = COALESCE($11, labels),
         position = COALESCE($12, position),
         completed_at = CASE WHEN $5 = 'done' THEN now()
                             WHEN $5 IS NOT NULL AND $5 <> 'done' THEN NULL
                             ELSE completed_at END,
         version = version + 1,
         updated_at = now()
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      [
        taskId,
        actor.companyId,
        input.title ?? null,
        input.description ?? null,
        input.status ?? null,
        input.priority ?? null,
        'assigneeId' in input,
        input.assigneeId ?? null,
        'dueAt' in input,
        input.dueAt ? new Date(input.dueAt) : null,
        input.labels ?? null,
        input.position ?? null,
      ],
    );
    const task = res.rows[0]!;

    // Activity history: one row per changed field.
    const changes: [string, unknown, unknown][] = [
      ['status', existing.status, task.status],
      ['priority', existing.priority, task.priority],
      ['assignee_id', existing.assignee_id, task.assignee_id],
      ['due_at', existing.due_at, task.due_at],
      ['title', existing.title, task.title],
    ];
    for (const [field, before, after] of changes) {
      if (String(before ?? '') === String(after ?? '')) continue;
      await tx.query(
        `INSERT INTO task_activity (company_id, task_id, actor_id, field, before_value, after_value)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [actor.companyId, taskId, actor.userId, field, String(before ?? ''), String(after ?? '')],
      );
    }
    if (task.assignee_id && task.assignee_id !== existing.assignee_id) {
      await tx.query('INSERT INTO task_watchers (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        taskId,
        task.assignee_id,
      ]);
      await emit(
        {
          companyId: actor.companyId,
          type: 'task.assigned',
          actorId: actor.userId,
          correlationId,
          payload: { taskId, assigneeId: task.assignee_id, title: task.title },
        },
        tx,
      );
    }
    await emit(
      {
        companyId: actor.companyId,
        type: 'task.updated',
        actorId: actor.userId,
        correlationId,
        payload: { taskId, projectId: task.project_id, status: task.status },
      },
      tx,
    );
    return task;
  });

  publish(`project:${updated.project_id}`, 'task.updated', { task: publicTask(updated) });
  return updated;
}

export async function getTask(actor: Actor, taskId: string) {
  const task = await one<TaskRow>('SELECT * FROM tasks WHERE id = $1 AND company_id = $2', [
    taskId,
    actor.companyId,
  ]);
  if (!task) throw notFound('Task not found');
  await requireProject(actor, task.project_id, 'task.update');
  const [comments, activity, dependencies, watchers] = await Promise.all([
    many(
      `SELECT c.id, c.body, c.created_at, u.display_name AS author_name, u.id AS author_id
         FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.task_id = $1 ORDER BY c.created_at`,
      [taskId],
    ),
    many(
      `SELECT a.field, a.before_value, a.after_value, a.created_at, u.display_name AS actor_name
         FROM task_activity a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.task_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [taskId],
    ),
    many(
      `SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
        WHERE d.task_id = $1`,
      [taskId],
    ),
    many(
      `SELECT u.id, u.display_name FROM task_watchers w JOIN users u ON u.id = w.user_id WHERE w.task_id = $1`,
      [taskId],
    ),
  ]);
  return { ...publicTask(task), comments, activity, dependencies, watchers };
}

export async function comment(actor: Actor, taskId: string, body: string) {
  const task = await one<TaskRow>('SELECT * FROM tasks WHERE id = $1 AND company_id = $2', [
    taskId,
    actor.companyId,
  ]);
  if (!task) throw notFound('Task not found');
  await requireProject(actor, task.project_id, 'task.update');
  const res = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO task_comments (company_id, task_id, author_id, body) VALUES ($1,$2,$3,$4)
     RETURNING id, created_at`,
    [actor.companyId, taskId, actor.userId, body.trim()],
  );
  await pool.query('INSERT INTO task_watchers (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
    taskId,
    actor.userId,
  ]);
  await emit({
    companyId: actor.companyId,
    type: 'task.updated',
    actorId: actor.userId,
    payload: { taskId, projectId: task.project_id, commented: true },
  });
  return { id: res.rows[0]!.id, body: body.trim(), createdAt: res.rows[0]!.created_at };
}

export async function indexTask(taskId: string): Promise<void> {
  const row = await one<{
    id: string;
    company_id: string;
    title: string;
    description: string;
    project_id: string;
  }>('SELECT id, company_id, title, description, project_id FROM tasks WHERE id = $1', [taskId]);
  if (!row) return;
  const members = await many<{ user_id: string }>(
    'SELECT user_id FROM project_members WHERE project_id = $1',
    [row.project_id],
  );
  await searchIndex.index({
    companyId: row.company_id,
    docType: 'task',
    resourceId: row.id,
    title: row.title,
    body: row.description,
    aclUserIds: members.map((m) => m.user_id),
    link: `/tasks/${row.id}`,
  });
}

export function publicTask(row: TaskRow & { assignee_name?: string | null; project_key?: string }) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    reference: row.project_key ? `${row.project_key}-${row.number}` : String(row.number),
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name ?? null,
    reporterId: row.reporter_id,
    dueAt: row.due_at,
    labels: row.labels,
    checklist: row.checklist,
    position: row.position,
    version: row.version,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
