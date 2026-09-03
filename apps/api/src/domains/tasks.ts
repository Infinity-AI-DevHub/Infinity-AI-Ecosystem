/**
 * Tasks and projects domain (blueprint 04).
 * Project membership governs task visibility; every field change is recorded in the
 * task activity history.
 */
import {
  isPgError,
  jsonArray,
  many,
  newId,
  one,
  PG,
  pool,
  reload,
  transaction,
} from '../core/db.js';
import { badRequest, conflict, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, decide, type Actor } from '../core/authz.js';
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
  labels: unknown;
  checklist: unknown;
  position: number;
  version: number;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Who is on a project, and changing that.
 *
 * `project_members` was written once at creation and never touched again - no domain
 * function, no route, no interface - so a project's membership was fixed for life and
 * nobody added later could see its tasks. Membership is what task access is built on,
 * so this is how someone joining a piece of work gets to it.
 */
export async function listProjectMembers(actor: Actor, projectId: string) {
  await requireProject(actor, projectId, 'task.read');
  return many<{ user_id: string; display_name: string; email_display: string; role: string | null }>(
    `SELECT m.user_id, m.role, u.display_name, u.email_display
       FROM project_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1
      ORDER BY m.role = 'owner' DESC, u.display_name`,
    [projectId],
  );
}

export async function addProjectMembers(
  actor: Actor,
  projectId: string,
  userIds: string[],
): Promise<{ added: number }> {
  await requireProject(actor, projectId, 'project.manage');
  if (userIds.length === 0) return { added: 0 };

  /*
   * 'invited' as well as 'active': somebody given an account but not yet signed in is a
   * perfectly ordinary person to put on a project, and they will need it waiting for
   * them when they do.
   *
   * Guests are excluded. A client contact reaches individual tasks and folders through a
   * share; making them a project member would hand them the whole board.
   */
  const eligible = await many<{ id: string }>(
    `SELECT id FROM users
      WHERE company_id = $1 AND status IN ('invited', 'active') AND access_level <> 'guest'
        AND id IN (${userIds.map((_, i) => `$${i + 2}`).join(',')})`,
    [actor.companyId, ...userIds],
  );
  if (eligible.length === 0) throw unprocessable('None of those people can join a project');

  await transaction(async (tx) => {
    for (const person of eligible) {
      await tx.query(
        `INSERT IGNORE INTO project_members (project_id, user_id) VALUES ($1, $2)`,
        [projectId, person.id],
      );
    }
    await auditFromActor(actor, 'project.members_added', {
      resourceType: 'project',
      resourceId: projectId,
      metadata: { userIds: eligible.map((p) => p.id) },
    }, tx);
  });

  return { added: eligible.length };
}

export async function removeProjectMember(
  actor: Actor,
  projectId: string,
  userId: string,
): Promise<void> {
  await requireProject(actor, projectId, 'project.manage');

  const member = await one<{ role: string | null }>(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId],
  );
  if (!member) throw notFound('They are not on this project');

  /*
   * The last owner stays. A project with no owner is one nobody can administer, and the
   * only route back is a database edit.
   */
  if (member.role === 'owner') {
    const owners = await one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner'",
      [projectId],
    );
    if (Number(owners?.n ?? 0) <= 1) {
      throw conflict('This is the last owner of the project. Make someone else an owner first.');
    }
  }

  await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]);
  await auditFromActor(actor, 'project.member_removed', {
    resourceType: 'project', resourceId: projectId, metadata: { userId },
  });
}

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
      const projectId = newId();
      await tx.query(
        `INSERT INTO projects (id, company_id, name, \`key\`, description, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [projectId, actor.companyId, input.name.trim(), key, input.description ?? '', actor.userId],
      );
      project = (await reload<ProjectRow>(tx, 'projects', projectId))!;
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) throw conflict('A project with that key already exists');
      throw err;
    }
    await tx.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')`, [
      project.id,
      actor.userId,
    ]);
    /*
     * Who else is on it is an audience decision, and it is the same decision whether it
     * is made at creation or afterwards — so it needs the same capability. Without this,
     * an employee who could not add a member to a project could still name one while
     * creating it, which is the same thing a minute earlier.
     */
    const mayChooseMembers = (
      await decide({
        actor,
        capability: 'project.manage',
        resourceType: 'project',
        resourceId: project.id,
        membership: true,
      })
    ).allowed;
    const invited = mayChooseMembers ? (input.memberIds ?? []) : [];
    for (const userId of invited.filter((id) => id !== actor.userId)) {
      await tx.query(
        `INSERT IGNORE INTO project_members (project_id, user_id) SELECT $1, id FROM users
          WHERE id = $2 AND company_id = $3 AND status = 'active'`,
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
            (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') AS open_tasks,
            (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) AS member_count
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.company_id = $1
        AND p.status = 'active'
        AND (pm.user_id IS NOT NULL OR $3)
      ORDER BY p.name`,
    [actor.companyId, actor.userId, actor.accessLevel === 'admin' || actor.accessLevel === 'super_admin'],
  );
}

/**
 * Editing a project.
 *
 * The key is immutable, like a leave type's: task references are built from it
 * (`WEB-14`), and they appear in commit messages, chat and email long after the task
 * itself is closed. Renaming freely is fine; re-keying would orphan every reference.
 */
export async function updateProject(
  actor: Actor,
  projectId: string,
  input: Partial<{
    name: string;
    description: string;
    status: 'active' | 'on_hold' | 'archived';
    ownerId: string | null;
    clientOrgId: string | null;
    startsOn: string | null;
    endsOn: string | null;
  }>,
): Promise<ProjectRow> {
  await authorize({ actor, capability: 'project.manage', resourceless: true });
  const existing = await one<ProjectRow>(
    'SELECT * FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, actor.companyId],
  );
  if (!existing) throw notFound('Project not found');

  if (input.name !== undefined && !input.name.trim()) throw badRequest('A project needs a name');
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    throw badRequest('The end date cannot be before the start date');
  }
  if (input.ownerId) await assertCompanyMember(actor.companyId, input.ownerId);

  await pool.query(
    `UPDATE projects
        SET name = COALESCE($3, name),
            description = COALESCE($4, description),
            status = COALESCE($5, status),
            owner_id = COALESCE($6, owner_id),
            client_org_id = COALESCE($7, client_org_id),
            starts_on = COALESCE($8, starts_on),
            ends_on = COALESCE($9, ends_on)
      WHERE id = $1 AND company_id = $2`,
    [
      projectId, actor.companyId,
      input.name?.trim() ?? null,
      input.description ?? null,
      input.status ?? null,
      input.ownerId ?? null,
      input.clientOrgId ?? null,
      input.startsOn ?? null,
      input.endsOn ?? null,
    ],
  );
  await auditFromActor(actor, 'project.update', {
    resourceType: 'project', resourceId: projectId, metadata: { changed: Object.keys(input) },
  });
  return (await one<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId]))!;
}

/**
 * Archiving a project.
 *
 * Deliberately not a delete. Tasks, invoices and time all point at a project, and
 * removing it would take a year of work with it. Archiving hides it from the pickers
 * while every reference still resolves - which is what "delete" is nearly always meant
 * to achieve here.
 */
export async function archiveProject(actor: Actor, projectId: string): Promise<void> {
  await authorize({ actor, capability: 'project.manage', resourceless: true });
  const open = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks
      WHERE project_id = $1 AND company_id = $2 AND status NOT IN ('done','cancelled')`,
    [projectId, actor.companyId],
  );
  if (Number(open?.n ?? 0) > 0) {
    throw conflict(
      `This project still has ${open!.n} task(s) open. Close or move them before archiving it.`,
    );
  }
  const result = await pool.query(
    `UPDATE projects SET status = 'archived' WHERE id = $1 AND company_id = $2`,
    [projectId, actor.companyId],
  );
  if (result.rowCount === 0) throw notFound('Project not found');
  await auditFromActor(actor, 'project.archive', {
    resourceType: 'project', resourceId: projectId,
  });
}

export async function createTask(
  actor: Actor,
  projectId: string,
  input: {
    title: string;
    description?: string;
    assigneeId?: string | null;
    /** Several people on one task. The first becomes the primary assignee. */
    assigneeIds?: string[];
    priority?: string;
    dueAt?: string | null;
    labels?: string[];
    dependsOn?: string[];
  },
  correlationId: string,
): Promise<TaskRow> {
  await requireProject(actor, projectId, 'task.create');
  if (input.assigneeId) await assertCompanyMember(actor.companyId, input.assigneeId);
  for (const id of input.assigneeIds ?? []) await assertCompanyMember(actor.companyId, id);

  const task = await transaction(async (tx) => {
    // Lock the project row so two concurrent creations cannot claim the same number.
    await tx.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    const numberRes = await tx.query<{ number: number }>(
      'SELECT COALESCE(max(number), 0) + 1 AS number FROM tasks WHERE project_id = $1',
      [projectId],
    );
    const taskId = newId();
    await tx.query(
      `INSERT INTO tasks
         (id, company_id, project_id, number, title, description, priority,
          assignee_id, reporter_id, due_at, labels, checklist)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        taskId,
        actor.companyId,
        projectId,
        numberRes.rows[0]?.number ?? 1,
        input.title.trim(),
        input.description ?? '',
        input.priority ?? 'medium',
        input.assigneeId ?? null,
        actor.userId,
        input.dueAt ? new Date(input.dueAt) : null,
        JSON.stringify(input.labels ?? []),
        JSON.stringify([]),
      ],
    );
    // A task may start life with several people on it.
    const initial = [...new Set(input.assigneeIds ?? (input.assigneeId ? [input.assigneeId] : []))];
    for (const userId of initial) {
      await tx.query(
        'INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1,$2,$3)',
        [taskId, userId, actor.userId],
      );
    }
    if (initial.length > 0 && !input.assigneeId) {
      await tx.query('UPDATE tasks SET assignee_id = $2 WHERE id = $1', [taskId, initial[0]]);
    }

    const created = (await reload<TaskRow>(tx, 'tasks', taskId))!;

    for (const dependencyId of input.dependsOn ?? []) {
      await assertNoDependencyCycle(created.id, dependencyId);
      await tx.query(
        'INSERT IGNORE INTO task_dependencies (task_id, depends_on) VALUES ($1,$2)',
        [created.id, dependencyId],
      );
    }
    await tx.query('INSERT IGNORE INTO task_watchers (task_id, user_id) VALUES ($1,$2)', [
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
  const cycle = await one<{ cycle_found: number }>(
    `WITH RECURSIVE chain AS (
       SELECT depends_on FROM task_dependencies WHERE task_id = $2
       UNION
       SELECT d.depends_on FROM task_dependencies d JOIN chain c ON d.task_id = c.depends_on
     )
     SELECT 1 AS cycle_found FROM chain WHERE depends_on = $1 LIMIT 1`,
    [taskId, dependsOn],
  );
  if (cycle) throw conflict('That dependency would create a cycle');
}

export async function listTasks(
  actor: Actor,
  filters: { projectId?: string; assigneeId?: string; status?: string; limit: number },
) {
  if (filters.projectId) await requireProject(actor, filters.projectId, 'task.read');
  return many<TaskRow & { assignee_name: string | null; project_key: string }>(
    `SELECT t.*, u.display_name AS assignee_name, p.key AS project_key,
            -- Every assignee, not just the primary one. JSON_ARRAYAGG over a LEFT JOIN
            -- yields [null] rather than [] for an unassigned task, so it is filtered
            -- to a real empty array in publicTask().
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', au.id, 'name', au.display_name))
               FROM task_assignees ta JOIN users au ON au.id = ta.user_id
              WHERE ta.task_id = t.id) AS assignees
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       -- LEFT, not INNER: a task shared directly with someone - a client given view
       -- access - reaches them through a grant, not through project membership. An
       -- inner join meant the share existed and the task never appeared.
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.company_id = $1
        AND (
          -- Administrators see every task in the company. The authorization layer
          -- already grants them an override on an individual task; without the same
          -- branch here, a project started by an employee never appeared in their list.
          $7
          OR pm.user_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM resource_grants g
             WHERE g.company_id = t.company_id
               AND g.resource_type = 'task' AND g.resource_id = t.id
               AND g.effect = 'allow'
               AND (g.expires_at IS NULL OR g.expires_at > NOW(3))
               AND g.subject_type = 'user' AND g.subject_id = $2
          )
        )
        AND ($3 IS NULL OR t.project_id = $3)
        AND ($4 IS NULL OR t.assignee_id = $4)
        AND ($5 IS NULL OR t.status = $5)
      ORDER BY t.position, t.created_at DESC
      LIMIT $6`,
    [
      actor.companyId,
      actor.userId,
      filters.projectId ?? null,
      filters.assigneeId ?? null,
      filters.status ?? null,
      filters.limit,
      actor.accessLevel === 'admin' || actor.accessLevel === 'super_admin',
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
    /** Replaces the whole set. Absent means "leave the assignees alone". */
    assigneeIds: string[];
    dueAt: string | null;
    labels: unknown;
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
  /*
   * Which capability this needs depends on what is being changed.
   *
   * Moving a card across the board is a different act from rewriting what the card says,
   * and an employee does the first without being trusted with the second. Assignment was
   * already separated this way; progress is the same idea one step further.
   *
   * Decided by what the caller actually sent, not by what they claim to be doing: a
   * request that changes the title needs `task.update` even if it also changes status.
   */
  const changingAssignees = input.assigneeId !== undefined || input.assigneeIds !== undefined;
  const PROGRESS_FIELDS = new Set(['status', 'position']);
  const changingDefinition = Object.keys(input).some(
    (field) => !PROGRESS_FIELDS.has(field) && input[field as keyof typeof input] !== undefined,
  );
  const capability = changingAssignees
    ? 'task.assign'
    : changingDefinition
      ? 'task.update'
      : 'task.progress';
  await requireProject(actor, existing.project_id, capability);
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
    await tx.query(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         status = COALESCE($5, status),
         priority = COALESCE($6, priority),
         assignee_id = CASE WHEN $7 THEN $8 ELSE assignee_id END,
         due_at = CASE WHEN $9 THEN $10 ELSE due_at END,
         labels = COALESCE($11, labels),
         position = COALESCE($12, position),
         completed_at = CASE WHEN $5 = 'done' THEN NOW(3)
                             WHEN $5 IS NOT NULL AND $5 <> 'done' THEN NULL
                             ELSE completed_at END,
         version = version + 1,
         updated_at = NOW(3)
       WHERE id = $1 AND company_id = $2`,
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
        input.labels ? JSON.stringify(input.labels) : null,
        input.position ?? null,
      ],
    );
    /**
     * Assignees, when the caller sent a set.
     *
     * Replaced wholesale rather than diffed: the client sends who should be on the task,
     * not a sequence of add and remove operations, so a lost request cannot leave the
     * set half-applied.
     *
     * tasks.assignee_id is kept in step as the primary assignee, because notifications
     * and the search index read that column.
     */
    if (input.assigneeIds !== undefined) {
      const unique = [...new Set(input.assigneeIds)];
      await tx.query('DELETE FROM task_assignees WHERE task_id = $1', [taskId]);
      for (const userId of unique) {
        await tx.query(
          `INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1,$2,$3)`,
          [taskId, userId, actor.userId],
        );
      }
      await tx.query('UPDATE tasks SET assignee_id = $2 WHERE id = $1', [taskId, unique[0] ?? null]);
    } else if ('assigneeId' in input) {
      // The single-assignee path stays supported, and keeps the join table consistent.
      await tx.query('DELETE FROM task_assignees WHERE task_id = $1', [taskId]);
      if (input.assigneeId) {
        await tx.query(
          `INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1,$2,$3)`,
          [taskId, input.assigneeId, actor.userId],
        );
      }
    }

    const task = (await reload<TaskRow>(tx, 'tasks', taskId))!;

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
      await tx.query('INSERT IGNORE INTO task_watchers (task_id, user_id) VALUES ($1,$2)', [
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

/**
 * Who may read a task.
 *
 * Two routes in, and the second one was missing. Normally you reach a task through its
 * project. But a task can also be shared directly - that is what "share with a client"
 * writes: a `task.read` grant on the task itself. Checking only the project meant a
 * client handed a task could never open it, and the share silently did nothing.
 *
 * The project check also asked for `task.update`, so reading required permission to
 * change - which locked out read-only roles as well as guests.
 */
async function requireTaskRead(actor: Actor, task: TaskRow): Promise<void> {
  try {
    await requireProject(actor, task.project_id, 'task.read');
    return;
  } catch {
    // Not reachable through the project; a direct share is the remaining possibility.
  }
  await authorize({
    actor,
    capability: 'task.read',
    resourceType: 'task',
    resourceId: task.id,
  });
}

export async function getTask(actor: Actor, taskId: string) {
  const task = await one<TaskRow>(
    `SELECT t.*, u.display_name AS assignee_name, p.\`key\` AS project_key,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', au.id, 'name', au.display_name))
               FROM task_assignees ta JOIN users au ON au.id = ta.user_id
              WHERE ta.task_id = t.id) AS assignees
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.id = $1 AND t.company_id = $2`,
    [taskId, actor.companyId],
  );
  if (!task) throw notFound('Task not found');
  await requireTaskRead(actor, task);
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
  /*
   * Commenting is participation, not editing. It sits with `task.progress` rather than
   * `task.update`, because saying what you did is the other half of moving the card —
   * requiring the editing capability would have left employees able to change a task's
   * status and unable to explain it.
   */
  await requireProject(actor, task.project_id, 'task.progress');
  const commentId = newId();
  await pool.query(
    `INSERT INTO task_comments (id, company_id, task_id, author_id, body) VALUES ($1,$2,$3,$4,$5)`,
    [commentId, actor.companyId, taskId, actor.userId, body.trim()],
  );
  await pool.query('INSERT IGNORE INTO task_watchers (task_id, user_id) VALUES ($1,$2)', [
    taskId,
    actor.userId,
  ]);
  await emit({
    companyId: actor.companyId,
    type: 'task.updated',
    actorId: actor.userId,
    payload: { taskId, projectId: task.project_id, commented: true },
  });
  return { id: commentId, body: body.trim(), createdAt: new Date() };
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

export function publicTask(
  row: TaskRow & {
    assignee_name?: string | null;
    project_key?: string;
    assignees?: unknown;
  },
) {
  /**
   * JSON_ARRAYAGG over a LEFT JOIN produces [null] for a task with no assignees, and the
   * driver hands JSON back either parsed or as a string depending on the column type.
   * Normalising here means no caller has to know either of those things.
   */
  const raw = typeof row.assignees === 'string' ? JSON.parse(row.assignees) : row.assignees;
  const assignees = Array.isArray(raw)
    ? raw.filter((entry): entry is { id: string; name: string } => Boolean(entry && (entry as { id?: string }).id))
    : [];
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
    assignees,
    reporterId: row.reporter_id,
    dueAt: row.due_at,
    labels: jsonArray(row.labels),
    checklist: row.checklist,
    position: row.position,
    version: row.version,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
