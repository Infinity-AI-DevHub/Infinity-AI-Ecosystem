/**
 * Employment records, performance reviews and goals.
 *
 * The directory knows a name, a title and a manager. It does not know when someone
 * joined, on what terms, what they are paid, or what was agreed at their last review -
 * which on a platform that is the company's only system means the employment
 * relationship itself lived in a spreadsheet.
 *
 * Two rules run through this module. Employment is history rather than current state,
 * because "what were they on in March" is asked by payroll, disputes and audits alike
 * and a single row of current values loses that answer every time anything changes. And
 * compensation is gated separately from everything else, because plenty of people need
 * an employment history without seeing what a colleague earns - it is the one thing here
 * that is sensitive between colleagues rather than only to outsiders.
 */
import { many, newId, one, reload, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { authorize, decide, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { encryptField, decryptField } from '../core/crypto.js';

export type EmploymentRow = {
  id: string;
  user_id: string;
  employment_type: string;
  job_title: string;
  department_id: string | null;
  manager_id: string | null;
  effective_from: Date;
  effective_to: Date | null;
  salary_encrypted: string | null;
  salary_currency: string;
  salary_period: string;
  weekly_hours: string | null;
  probation_ends: Date | null;
  change_reason: string | null;
};

/** Whether the actor may see compensation, which is a narrower question than the record. */
async function canSeeCompensation(actor: Actor): Promise<boolean> {
  const decision = await decide({ actor, capability: 'hr.compensation', resourceless: true });
  return decision.allowed;
}

function presentEmployment(row: EmploymentRow, withSalary: boolean) {
  const { salary_encrypted, ...rest } = row;
  return {
    ...rest,
    // Absent rather than null when withheld, so a client cannot mistake "not allowed to
    // see it" for "nothing recorded".
    ...(withSalary && salary_encrypted
      ? { salary: Number(decryptField(salary_encrypted)) }
      : {}),
    salaryVisible: withSalary,
  };
}

export async function employmentHistory(actor: Actor, userId: string) {
  // Your own record is always readable; anyone else's is an HR act.
  if (userId !== actor.userId) {
    await authorize({ actor, capability: 'hr.read_all', resourceless: true });
  }
  const rows = await many<EmploymentRow>(
    `SELECT e.*, d.name AS department_name, m.display_name AS manager_name,
            r.display_name AS recorded_by_name
       FROM employment_records e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users m ON m.id = e.manager_id
       LEFT JOIN users r ON r.id = e.recorded_by
      WHERE e.user_id = $1 AND e.company_id = $2
      ORDER BY e.effective_from DESC`,
    [userId, actor.companyId],
  );
  // People may always see their own pay.
  const withSalary = userId === actor.userId || (await canSeeCompensation(actor));
  return rows.map((row) => presentEmployment(row, withSalary));
}

/**
 * Records a change of terms.
 *
 * The previous record is closed the day before this one starts rather than deleted, so
 * the history stays continuous and gapless. A change effective before an existing record
 * is refused: back-dating over a period someone was already paid under other terms is
 * not an edit, it is a correction, and it should be visible as one.
 */
export async function recordEmployment(
  actor: Actor,
  userId: string,
  input: {
    employmentType?: string;
    jobTitle: string;
    departmentId?: string | null;
    managerId?: string | null;
    effectiveFrom: string;
    salary?: number | null;
    salaryCurrency?: string;
    salaryPeriod?: string;
    weeklyHours?: number | null;
    probationEnds?: string | null;
    changeReason?: string | null;
  },
) {
  await authorize({ actor, capability: 'hr.manage', resourceless: true });
  if (input.salary !== undefined && input.salary !== null) {
    await authorize({ actor, capability: 'hr.compensation', resourceless: true });
  }

  const subject = await one<{ id: string }>(
    'SELECT id FROM users WHERE id = $1 AND company_id = $2',
    [userId, actor.companyId],
  );
  if (!subject) throw notFound('Account not found');
  if (input.managerId === userId) {
    throw unprocessable('A person cannot be their own manager', [
      { field: 'managerId', message: 'Choose someone else' },
    ]);
  }

  const current = await one<{ id: string; effective_from: Date }>(
    `SELECT id, effective_from FROM employment_records
      WHERE user_id = $1 AND effective_to IS NULL
      ORDER BY effective_from DESC LIMIT 1`,
    [userId],
  );
  if (current && new Date(input.effectiveFrom) <= new Date(current.effective_from)) {
    throw conflict(
      'That start date is on or before the current terms. Records are kept in order so the history stays readable.',
    );
  }

  const id = newId();
  return transaction(async (tx) => {
    if (current) {
      await tx.query(
        'UPDATE employment_records SET effective_to = DATE_SUB($2, INTERVAL 1 DAY) WHERE id = $1',
        [current.id, input.effectiveFrom],
      );
    }
    await tx.query(
      `INSERT INTO employment_records
         (id, company_id, user_id, employment_type, job_title, department_id, manager_id,
          effective_from, salary_encrypted, salary_currency, salary_period, weekly_hours,
          probation_ends, change_reason, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        actor.companyId,
        userId,
        input.employmentType ?? 'permanent',
        input.jobTitle.trim(),
        input.departmentId ?? null,
        input.managerId ?? null,
        input.effectiveFrom,
        input.salary !== undefined && input.salary !== null
          ? encryptField(String(input.salary))
          : null,
        input.salaryCurrency ?? 'USD',
        input.salaryPeriod ?? 'year',
        input.weeklyHours ?? null,
        input.probationEnds || null,
        input.changeReason?.trim() || null,
        actor.userId,
      ],
    );

    // The directory reflects the current terms, so the two cannot drift apart.
    await tx.query(
      `UPDATE users SET title = $2, department_id = COALESCE($3, department_id),
              manager_id = COALESCE($4, manager_id), version = version + 1, updated_at = NOW(3)
        WHERE id = $1`,
      [userId, input.jobTitle.trim(), input.departmentId ?? null, input.managerId ?? null],
    );

    await auditFromActor(actor, 'hr.employment_record', {
      resourceType: 'user',
      resourceId: userId,
      // The amount itself is never written to the audit metadata; that it changed is
      // enough for an auditor, and the trail is read far more widely than the record.
      metadata: {
        jobTitle: input.jobTitle,
        effectiveFrom: input.effectiveFrom,
        salaryChanged: input.salary !== undefined && input.salary !== null,
        reason: input.changeReason ?? null,
      },
    }, tx);

    const row = (await reload<EmploymentRow>(tx, 'employment_records', id))!;
    return presentEmployment(row, true);
  });
}

// ------------------------------------------------------------------ reviews

export async function listCycles(actor: Actor) {
  await authorize({ actor, capability: 'review.conduct', resourceless: true });
  return many(
    `SELECT c.*, (SELECT COUNT(*) FROM performance_reviews r WHERE r.cycle_id = c.id) AS review_count
       FROM review_cycles c WHERE c.company_id = $1 ORDER BY c.opens_on DESC`,
    [actor.companyId],
  );
}

/**
 * Opens a cycle and creates a review for everyone with a manager.
 *
 * Generated rather than created by hand: a cycle where somebody was forgotten is worse
 * than no cycle, and the manager relationship already exists in the directory.
 */
export async function openCycle(
  actor: Actor,
  input: { name: string; opensOn: string; closesOn: string },
) {
  await authorize({ actor, capability: 'review.manage', resourceless: true });
  const id = newId();

  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO review_cycles (id, company_id, name, opens_on, closes_on, state, created_by)
       VALUES ($1,$2,$3,$4,$5,'open',$6)`,
      [id, actor.companyId, input.name.trim(), input.opensOn, input.closesOn, actor.userId],
    );

    const staff = await tx.query(
      `SELECT id, manager_id FROM users
        WHERE company_id = $1 AND status = 'active' AND access_level <> 'guest'
          AND manager_id IS NOT NULL`,
      [actor.companyId],
    );
    for (const person of staff.rows as { id: string; manager_id: string }[]) {
      await tx.query(
        `INSERT IGNORE INTO performance_reviews (id, company_id, cycle_id, subject_id, reviewer_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId(), actor.companyId, id, person.id, person.manager_id],
      );
    }

    await auditFromActor(actor, 'review.cycle_open', {
      resourceType: 'company',
      resourceId: actor.companyId,
      metadata: { name: input.name, reviews: (staff.rows as unknown[]).length },
    }, tx);
    return (await reload(tx, 'review_cycles', id))!;
  });
}

export async function myReviews(actor: Actor) {
  return many(
    `SELECT r.*, c.name AS cycle_name, c.closes_on,
            s.display_name AS subject_name, v.display_name AS reviewer_name
       FROM performance_reviews r
       JOIN review_cycles c ON c.id = r.cycle_id
       JOIN users s ON s.id = r.subject_id
       JOIN users v ON v.id = r.reviewer_id
      WHERE r.company_id = $1 AND (r.subject_id = $2 OR r.reviewer_id = $2)
      ORDER BY c.opens_on DESC`,
    [actor.companyId, actor.userId],
  );
}

export async function getReview(actor: Actor, reviewId: string) {
  const review = await one<{
    id: string;
    subject_id: string;
    reviewer_id: string;
    manager_assessment: string | null;
    shared_at: Date | null;
    state: string;
  }>(
    `SELECT r.*, c.name AS cycle_name, s.display_name AS subject_name, v.display_name AS reviewer_name
       FROM performance_reviews r
       JOIN review_cycles c ON c.id = r.cycle_id
       JOIN users s ON s.id = r.subject_id
       JOIN users v ON v.id = r.reviewer_id
      WHERE r.id = $1 AND r.company_id = $2`,
    [reviewId, actor.companyId],
  );
  if (!review) throw notFound('Review not found');

  const involved = review.subject_id === actor.userId || review.reviewer_id === actor.userId;
  if (!involved) await authorize({ actor, capability: 'hr.read_all', resourceless: true });

  // The subject sees the manager's assessment only once it has been shared. A manager
  // writing notes is thinking aloud; the person reading them half-finished is how a
  // review becomes an argument about a draft.
  if (review.subject_id === actor.userId && review.reviewer_id !== actor.userId && !review.shared_at) {
    return { ...review, manager_assessment: null, manager_withheld: true };
  }
  return { ...review, manager_withheld: false };
}

export async function saveSelfAssessment(actor: Actor, reviewId: string, text: string) {
  const review = await one<{ subject_id: string; state: string }>(
    'SELECT subject_id, state FROM performance_reviews WHERE id = $1 AND company_id = $2',
    [reviewId, actor.companyId],
  );
  if (!review) throw notFound('Review not found');
  if (review.subject_id !== actor.userId) {
    throw forbidden('Only the person being reviewed can write their self-assessment');
  }
  if (review.state === 'closed') throw conflict('This review is closed');

  await transaction(async (tx) => {
    await tx.query(
      `UPDATE performance_reviews
          SET self_assessment = $2, self_submitted_at = NOW(3),
              state = CASE WHEN state = 'pending' THEN 'self_done' ELSE state END
        WHERE id = $1`,
      [reviewId, text],
    );
    await auditFromActor(actor, 'review.self_assessment', {
      resourceType: 'user',
      resourceId: actor.userId,
      metadata: { reviewId },
    }, tx);
  });
}

export async function saveManagerAssessment(
  actor: Actor,
  reviewId: string,
  input: { text: string; rating?: string | null; share?: boolean },
) {
  await authorize({ actor, capability: 'review.conduct', resourceless: true });
  const review = await one<{ reviewer_id: string; subject_id: string; state: string }>(
    'SELECT reviewer_id, subject_id, state FROM performance_reviews WHERE id = $1 AND company_id = $2',
    [reviewId, actor.companyId],
  );
  if (!review) throw notFound('Review not found');
  if (review.reviewer_id !== actor.userId) {
    throw forbidden('Only the assigned reviewer can write this assessment');
  }
  if (review.subject_id === actor.userId) {
    throw forbidden('Nobody reviews themselves');
  }
  if (review.state === 'closed') throw conflict('This review is closed');

  await transaction(async (tx) => {
    await tx.query(
      `UPDATE performance_reviews
          SET manager_assessment = $2, rating = $3, manager_submitted_at = NOW(3),
              state = $4, shared_at = CASE WHEN $5 THEN NOW(3) ELSE shared_at END
        WHERE id = $1`,
      [reviewId, input.text, input.rating ?? null, input.share ? 'shared' : 'manager_done', input.share ?? false],
    );
    await auditFromActor(actor, input.share ? 'review.shared' : 'review.manager_assessment', {
      resourceType: 'user',
      resourceId: review.subject_id,
      metadata: { reviewId, rating: input.rating ?? null },
    }, tx);
  });
}

// ------------------------------------------------------------------ goals

export async function listGoals(actor: Actor, userId?: string) {
  const target = userId ?? actor.userId;
  if (target !== actor.userId) {
    await authorize({ actor, capability: 'hr.read_all', resourceless: true });
  }
  return many(
    `SELECT g.*, c.name AS cycle_name
       FROM goals g
       LEFT JOIN review_cycles c ON c.id = g.cycle_id
      WHERE g.company_id = $1 AND g.user_id = $2
      ORDER BY FIELD(g.status,'at_risk','active','achieved','dropped'), g.due_on`,
    [actor.companyId, target],
  );
}

export async function createGoal(
  actor: Actor,
  input: { userId?: string; title: string; detail?: string | null; dueOn?: string | null; cycleId?: string | null },
) {
  await authorize({ actor, capability: 'goal.manage', resourceless: true });
  const target = input.userId ?? actor.userId;
  // Setting a goal for someone else is a management act, not a peer one.
  if (target !== actor.userId) {
    const subject = await one<{ manager_id: string | null }>(
      'SELECT manager_id FROM users WHERE id = $1 AND company_id = $2',
      [target, actor.companyId],
    );
    if (!subject) throw notFound('Account not found');
    if (subject.manager_id !== actor.userId) {
      await authorize({ actor, capability: 'hr.manage', resourceless: true });
    }
  }

  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO goals (id, company_id, user_id, cycle_id, title, detail, due_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.companyId, target, input.cycleId ?? null, input.title.trim(), input.detail?.trim() || null, input.dueOn || null],
    );
    await auditFromActor(actor, 'goal.create', {
      resourceType: 'user',
      resourceId: target,
      metadata: { title: input.title },
    }, tx);
    return (await reload(tx, 'goals', id))!;
  });
}

export async function updateGoal(
  actor: Actor,
  goalId: string,
  input: { progress?: number; status?: string; title?: string; detail?: string | null },
) {
  const goal = await one<{ user_id: string }>(
    'SELECT user_id FROM goals WHERE id = $1 AND company_id = $2',
    [goalId, actor.companyId],
  );
  if (!goal) throw notFound('Goal not found');
  if (goal.user_id !== actor.userId) {
    await authorize({ actor, capability: 'hr.manage', resourceless: true });
  }

  await transaction(async (tx) => {
    await tx.query(
      `UPDATE goals
          SET progress = COALESCE($2, progress), status = COALESCE($3, status),
              title = COALESCE($4, title), detail = COALESCE($5, detail), updated_at = NOW(3)
        WHERE id = $1`,
      [goalId, input.progress ?? null, input.status ?? null, input.title?.trim() ?? null, input.detail ?? null],
    );
    await auditFromActor(actor, 'goal.update', {
      resourceType: 'user',
      resourceId: goal.user_id,
      metadata: { goalId, progress: input.progress ?? null, status: input.status ?? null },
    }, tx);
  });
}
