/**
 * Academy: courses and assignments, certifications, the skills register and policy
 * acknowledgement.
 *
 * Completion is earned, not declared: every lesson marked done and, when a course has a
 * quiz, a passing attempt. Completing a certifying course issues the certification with
 * its expiry and confirms the skills the course develops. Answers are marked on the
 * server; the correct option never leaves it.
 *
 * Policies are versioned. What someone acknowledges is one exact published text, and a
 * new version asks everyone in the audience again.
 */
import { many, newId, one, parseJson, pool, transaction, type Queryable } from '../core/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import * as notifications from './notifications.js';
import * as searchIndex from './search.js';

const DAY = 86_400_000;
const placeholders = (n: number, start = 1) => Array.from({ length: n }, (_, i) => `$${i + start}`).join(',');

function requireLearn(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
  return authorize({ actor, capability: 'academy.learn', resourceless: true });
}
const requireManage = (actor: Actor) => authorize({ actor, capability: 'academy.manage', resourceless: true });

function httpUrl(value: string | null | undefined, field: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!/^https?:\/\/\S+$/i.test(v)) throw unprocessable('Links must start with http:// or https://', [{ field, message: 'Enter a web address' }]);
  return v.slice(0, 500);
}

/** Pure: marks a quiz. Exported for tests. */
export function markQuiz(correct: number[], answers: (number | null)[], passMark: number): { score: number; passed: boolean } {
  if (correct.length === 0) return { score: 100, passed: true };
  const right = correct.filter((c, i) => answers[i] === c).length;
  const score = Math.round((right / correct.length) * 100);
  return { score, passed: score >= passMark };
}

/** Pure: when a certification lapses, given when it was issued. Exported for tests. */
export function certificationExpiry(issuedAt: Date, validityMonths: number | null): Date | null {
  if (!validityMonths) return null;
  const d = new Date(issuedAt);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + validityMonths);
  // 31 January plus one month is the last day of February, not 3 March.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/* ------------------------------------------------------------------ courses */

type CourseRow = {
  id: string; company_id: string; title: string; summary: string | null; category: string | null; status: 'draft' | 'published' | 'archived';
  pass_mark: number | null; certification_name: string | null; validity_months: number | null; owner_id: string | null; updated_at: Date;
};
type EnrolmentRow = { id: string; company_id: string; course_id: string; user_id: string; source: string; due_at: Date | null; status: 'in_progress' | 'completed'; score: number | null; attempts: number; started_at: Date; completed_at: Date | null };

async function loadCourse(actor: Actor, id: string, db: Queryable = pool): Promise<CourseRow> {
  await requireLearn(actor);
  const c = (await db.query<CourseRow>('SELECT * FROM courses WHERE id = $1 AND company_id = $2', [id, actor.companyId])).rows[0];
  // A draft is invisible to learners, not forbidden: it does not exist for them yet.
  if (!c || (c.status !== 'published' && !hasCapability(actor, 'academy.manage'))) throw notFound('Course not found');
  return c;
}

export async function listCourses(actor: Actor, filter: { q?: string; status?: string; category?: string }) {
  await requireLearn(actor);
  const manage = hasCapability(actor, 'academy.manage');
  const where = ['c.company_id = $1'];
  const params: unknown[] = [actor.companyId, actor.userId];
  if (!manage) where.push("c.status = 'published'");
  else if (filter.status) { params.push(filter.status); where.push(`c.status = $${params.length}`); }
  if (filter.category) { params.push(filter.category); where.push(`c.category = $${params.length}`); }
  if (filter.q?.trim()) { params.push(`%${filter.q.trim().replace(/[%_\\]/g, '\\$&')}%`); where.push(`(c.title LIKE $${params.length} OR c.summary LIKE $${params.length})`); }
  const rows = await many<CourseRow & { lessons: number; minutes: number; enrolled: number; completed: number; my_status: string | null; my_due: Date | null; my_done: number }>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM course_lessons l WHERE l.course_id = c.id) AS lessons,
            (SELECT COALESCE(SUM(minutes), 0) FROM course_lessons l WHERE l.course_id = c.id) AS minutes,
            (SELECT COUNT(*) FROM enrolments e WHERE e.course_id = c.id) AS enrolled,
            (SELECT COUNT(*) FROM enrolments e WHERE e.course_id = c.id AND e.status = 'completed') AS completed,
            me.status AS my_status, me.due_at AS my_due,
            (SELECT COUNT(*) FROM lesson_progress p WHERE p.enrolment_id = me.id) AS my_done
       FROM courses c LEFT JOIN enrolments me ON me.course_id = c.id AND me.user_id = $2
      WHERE ${where.join(' AND ')} ORDER BY FIELD(c.status,'published','draft','archived'), c.title LIMIT 200`, params);
  return rows.map((c) => ({
    id: c.id, title: c.title, summary: c.summary, category: c.category, status: c.status, lessons: Number(c.lessons), minutes: Number(c.minutes),
    hasQuiz: c.pass_mark !== null, certificationName: c.certification_name, validityMonths: c.validity_months,
    enrolled: manage ? Number(c.enrolled) : undefined, completed: manage ? Number(c.completed) : undefined,
    mine: c.my_status ? { status: c.my_status, dueAt: c.my_due, lessonsDone: Number(c.my_done) } : null,
  }));
}

export async function getCourse(actor: Actor, id: string) {
  const c = await loadCourse(actor, id);
  const manage = hasCapability(actor, 'academy.manage');
  const lessons = await many<{ id: string; position: number; title: string; body: string; video_url: string | null; minutes: number }>(
    'SELECT id, position, title, body, video_url, minutes FROM course_lessons WHERE course_id = $1 ORDER BY position, title', [id]);
  const questions = await many<{ id: string; prompt: string; options: unknown; correct_index: number }>(
    'SELECT id, prompt, options, correct_index FROM course_questions WHERE course_id = $1 ORDER BY position', [id]);
  const skills = await many<{ id: string; name: string; level: number }>(
    'SELECT s.id, s.name, cs.level FROM course_skills cs JOIN skills s ON s.id = cs.skill_id WHERE cs.course_id = $1 ORDER BY s.name', [id]);
  const enrolment = await one<EnrolmentRow>('SELECT * FROM enrolments WHERE course_id = $1 AND user_id = $2', [id, actor.userId]);
  const done = enrolment ? await many<{ lesson_id: string }>('SELECT lesson_id FROM lesson_progress WHERE enrolment_id = $1', [enrolment.id]) : [];
  const lastAttempt = enrolment ? await one<{ score: number; passed: number; created_at: Date }>('SELECT score, passed, created_at FROM quiz_attempts WHERE enrolment_id = $1 ORDER BY created_at DESC LIMIT 1', [enrolment.id]) : null;
  const cert = await one<{ id: string; issued_at: Date; expires_at: Date | null }>('SELECT id, issued_at, expires_at FROM certifications WHERE user_id = $1 AND course_id = $2 ORDER BY issued_at DESC LIMIT 1', [actor.userId, id]);
  const owner = c.owner_id ? await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [c.owner_id]) : null;
  return {
    id: c.id, title: c.title, summary: c.summary, category: c.category, status: c.status, passMark: c.pass_mark,
    certificationName: c.certification_name, validityMonths: c.validity_months, owner: c.owner_id ? { id: c.owner_id, name: owner?.display_name ?? null } : null,
    lessons: lessons.map((l) => ({ id: l.id, position: l.position, title: l.title, body: l.body, videoUrl: l.video_url, minutes: l.minutes, done: done.some((d) => d.lesson_id === l.id) })),
    // Learners get the questions without the answers.
    questions: questions.map((q) => ({ id: q.id, prompt: q.prompt, options: parseJson<string[]>(q.options, []), ...(manage ? { correctIndex: q.correct_index } : {}) })),
    skills,
    enrolment: enrolment ? { id: enrolment.id, status: enrolment.status, source: enrolment.source, dueAt: enrolment.due_at, score: enrolment.score, attempts: enrolment.attempts, completedAt: enrolment.completed_at } : null,
    lastAttempt: lastAttempt ? { score: lastAttempt.score, passed: Boolean(lastAttempt.passed), at: lastAttempt.created_at } : null,
    certification: cert ? { id: cert.id, issuedAt: cert.issued_at, expiresAt: cert.expires_at, expired: Boolean(cert.expires_at && new Date(cert.expires_at) < new Date()) } : null,
    permissions: { canManage: manage },
  };
}

type CourseInput = { title: string; summary?: string | null; category?: string | null; passMark?: number | null; certificationName?: string | null; validityMonths?: number | null; ownerId?: string | null; skills?: { skillId: string; level: number }[] };

export async function saveCourse(actor: Actor, id: string | null, input: CourseInput) {
  await requireManage(actor);
  if (input.validityMonths && !input.certificationName) throw unprocessable('Validity only applies to a course that issues a certification', [{ field: 'validityMonths', message: 'Name the certification, or clear the validity' }]);
  if (input.ownerId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND access_level <> 'guest'", [input.ownerId, actor.companyId]))) throw unprocessable('Person not found', [{ field: 'ownerId', message: 'Choose an employee' }]);
  for (const s of input.skills ?? []) {
    if (!(await one('SELECT 1 FROM skills WHERE id = $1 AND company_id = $2', [s.skillId, actor.companyId]))) throw unprocessable('Skill not found', [{ field: 'skills', message: 'Choose again' }]);
  }
  const courseId = id ?? newId();
  await transaction(async (tx) => {
    const values = [input.title.trim(), input.summary?.trim() || null, input.category?.trim() || null, input.passMark ?? null, input.certificationName?.trim() || null, input.validityMonths ?? null, input.ownerId ?? null];
    if (id) {
      const res = await tx.query('UPDATE courses SET title = $3, summary = $4, category = $5, pass_mark = $6, certification_name = $7, validity_months = $8, owner_id = $9 WHERE id = $1 AND company_id = $2', [id, actor.companyId, ...values]);
      if (res.rowCount === 0) throw notFound('Course not found');
    } else {
      await tx.query('INSERT INTO courses (id, company_id, title, summary, category, pass_mark, certification_name, validity_months, owner_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [courseId, actor.companyId, ...values, actor.userId]);
    }
    if (input.skills) {
      await tx.query('DELETE FROM course_skills WHERE course_id = $1', [courseId]);
      for (const s of input.skills) await tx.query('INSERT INTO course_skills (course_id, skill_id, level) VALUES ($1,$2,$3)', [courseId, s.skillId, s.level]);
    }
    await auditFromActor(actor, id ? 'course.update' : 'course.create', { resourceType: 'course', resourceId: courseId }, tx);
  });
  return { id: courseId };
}

export async function saveLesson(actor: Actor, courseId: string, lessonId: string | null, input: { title: string; body: string; videoUrl?: string | null; minutes: number; position?: number }) {
  await requireManage(actor);
  await loadCourse(actor, courseId);
  const videoUrl = httpUrl(input.videoUrl, 'videoUrl');
  const id = lessonId ?? newId();
  if (lessonId) {
    const res = await pool.query('UPDATE course_lessons SET title = $3, body = $4, video_url = $5, minutes = $6, position = COALESCE($7, position) WHERE id = $1 AND course_id = $2', [lessonId, courseId, input.title.trim(), input.body, videoUrl, input.minutes, input.position ?? null]);
    if (res.rowCount === 0) throw notFound('Lesson not found');
  } else {
    const pos = input.position ?? Number((await one<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM course_lessons WHERE course_id = $1', [courseId]))?.n ?? 0);
    await pool.query('INSERT INTO course_lessons (id, course_id, position, title, body, video_url, minutes) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, courseId, pos, input.title.trim(), input.body, videoUrl, input.minutes]);
  }
  await auditFromActor(actor, lessonId ? 'course.lesson.update' : 'course.lesson.create', { resourceType: 'course', resourceId: courseId });
  return { id };
}

export async function deleteLesson(actor: Actor, courseId: string, lessonId: string) {
  await requireManage(actor);
  await loadCourse(actor, courseId);
  const res = await pool.query('DELETE FROM course_lessons WHERE id = $1 AND course_id = $2', [lessonId, courseId]);
  if (res.rowCount === 0) throw notFound('Lesson not found');
  await auditFromActor(actor, 'course.lesson.delete', { resourceType: 'course', resourceId: courseId });
}

export async function saveQuestions(actor: Actor, courseId: string, questions: { prompt: string; options: string[]; correctIndex: number }[]) {
  await requireManage(actor);
  const c = await loadCourse(actor, courseId);
  for (const [i, q] of questions.entries()) {
    if (q.correctIndex >= q.options.length) throw unprocessable(`Question ${i + 1} marks an option that does not exist as correct`, [{ field: `questions.${i}.correctIndex`, message: 'Choose one of the options' }]);
  }
  await transaction(async (tx) => {
    await tx.query('DELETE FROM course_questions WHERE course_id = $1', [courseId]);
    for (const [i, q] of questions.entries()) {
      await tx.query('INSERT INTO course_questions (id, course_id, position, prompt, options, correct_index) VALUES ($1,$2,$3,$4,$5,$6)', [newId(), courseId, i, q.prompt.trim(), JSON.stringify(q.options.map((o) => o.trim())), q.correctIndex]);
    }
    await auditFromActor(actor, 'course.quiz.update', { resourceType: 'course', resourceId: courseId, metadata: { questions: questions.length, published: c.status === 'published' } }, tx);
  });
}

export async function setCourseStatus(actor: Actor, courseId: string, status: 'draft' | 'published' | 'archived') {
  await requireManage(actor);
  const c = await loadCourse(actor, courseId);
  if (status === 'published') {
    const lessons = await one<{ n: number }>('SELECT COUNT(*) AS n FROM course_lessons WHERE course_id = $1', [courseId]);
    if (!Number(lessons?.n)) throw unprocessable('Add at least one lesson before publishing');
    const questions = await one<{ n: number }>('SELECT COUNT(*) AS n FROM course_questions WHERE course_id = $1', [courseId]);
    if (c.pass_mark !== null && !Number(questions?.n)) throw unprocessable('This course has a pass mark but no quiz questions');
  }
  await pool.query('UPDATE courses SET status = $2 WHERE id = $1', [courseId, status]);
  // Only published courses are findable; a draft title is not something to announce.
  if (status === 'published') await searchIndex.index({ companyId: actor.companyId, docType: 'course', resourceId: courseId, title: c.title, body: `${c.title} ${c.summary ?? ''} ${c.category ?? ''}`, aclCompanyWide: true, link: `/academy/courses/${courseId}` });
  else await searchIndex.remove('course', courseId);
  await auditFromActor(actor, `course.${status === 'published' ? 'publish' : status === 'archived' ? 'archive' : 'unpublish'}`, { resourceType: 'course', resourceId: courseId });
}

/* -------------------------------------------------------------- enrolments */

export async function enrol(actor: Actor, courseId: string) {
  const c = await loadCourse(actor, courseId);
  if (c.status !== 'published') throw conflict('Only published courses can be started');
  await pool.query('INSERT IGNORE INTO enrolments (id, company_id, course_id, user_id, source) VALUES ($1,$2,$3,$4,\'self\')', [newId(), actor.companyId, courseId, actor.userId]);
  return getCourse(actor, courseId);
}

export async function assign(actor: Actor, courseId: string, input: { userIds?: string[]; groupId?: string | null; dueAt?: string | null }) {
  await requireManage(actor);
  const c = await loadCourse(actor, courseId);
  if (c.status !== 'published') throw conflict('Publish the course before assigning it');
  const ids = new Set(input.userIds ?? []);
  if (input.groupId) {
    const group = await one('SELECT 1 FROM `groups` WHERE id = $1 AND company_id = $2', [input.groupId, actor.companyId]);
    if (!group) throw unprocessable('Group not found', [{ field: 'groupId', message: 'Choose a group' }]);
    for (const m of await many<{ user_id: string }>('SELECT user_id FROM group_members WHERE group_id = $1', [input.groupId])) ids.add(m.user_id);
  }
  if (ids.size === 0) throw unprocessable('Choose people or a group to assign', [{ field: 'userIds', message: 'Required' }]);
  const people = await many<{ id: string }>(`SELECT id FROM users WHERE company_id = $1 AND status = 'active' AND access_level <> 'guest' AND id IN (${placeholders(ids.size, 2)})`, [actor.companyId, ...ids]);
  if (input.userIds?.some((u) => !people.some((p) => p.id === u))) throw unprocessable('Someone chosen is not an active employee', [{ field: 'userIds', message: 'Choose active employees' }]);
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  let assigned = 0;
  for (const p of people) {
    // Assigning someone who already started keeps their progress and sets the due date.
    const res = await pool.query(
      `INSERT INTO enrolments (id, company_id, course_id, user_id, source, assigned_by, due_at) VALUES ($1,$2,$3,$4,'assigned',$5,$6)
       ON DUPLICATE KEY UPDATE due_at = IF(status = 'completed', due_at, VALUES(due_at)), assigned_by = IF(status = 'completed', assigned_by, VALUES(assigned_by)), source = IF(status = 'completed', source, 'assigned')`,
      [newId(), actor.companyId, courseId, p.id, actor.userId, dueAt]);
    if (res.rowCount) assigned += 1;
    await notifications.create({
      companyId: actor.companyId, userId: p.id, type: 'course.assigned', title: `Training assigned: ${c.title}`,
      body: dueAt ? `Complete by ${dueAt.toISOString().slice(0, 10)}` : undefined, link: `/academy/courses/${courseId}`,
      resourceType: 'course', resourceId: courseId, dedupeKey: `course.assigned:${courseId}:${p.id}:${dueAt?.toISOString() ?? 'none'}`,
    });
  }
  await auditFromActor(actor, 'course.assign', { resourceType: 'course', resourceId: courseId, metadata: { people: people.length, groupId: input.groupId ?? null } });
  return { assigned: people.length };
}

async function myEnrolment(actor: Actor, courseId: string) {
  const e = await one<EnrolmentRow>('SELECT * FROM enrolments WHERE course_id = $1 AND user_id = $2', [courseId, actor.userId]);
  if (!e) throw conflict('Start the course first');
  return e;
}

async function completeIfDone(companyId: string, course: CourseRow, enrolment: EnrolmentRow) {
  if (enrolment.status === 'completed') return;
  const pending = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM course_lessons l WHERE l.course_id = $1 AND NOT EXISTS (SELECT 1 FROM lesson_progress p WHERE p.enrolment_id = $2 AND p.lesson_id = l.id)', [course.id, enrolment.id]);
  if (Number(pending?.n)) return;
  if (course.pass_mark !== null && !(await one('SELECT 1 FROM quiz_attempts WHERE enrolment_id = $1 AND passed = 1', [enrolment.id]))) return;
  const now = new Date();
  await transaction(async (tx) => {
    const claimed = await tx.query("UPDATE enrolments SET status = 'completed', completed_at = $2 WHERE id = $1 AND status = 'in_progress'", [enrolment.id, now]);
    if (!claimed.rowCount) return;
    if (course.certification_name) {
      await tx.query('INSERT INTO certifications (id, company_id, user_id, course_id, name, issuer, issued_at, expires_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'course\')',
        [newId(), companyId, enrolment.user_id, course.id, course.certification_name, 'Infinity Academy', now, certificationExpiry(now, course.validity_months)]);
    }
    // A course confirms skills up to its level; it never lowers what someone already has.
    for (const s of await many<{ skill_id: string; level: number }>('SELECT skill_id, level FROM course_skills WHERE course_id = $1', [course.id])) {
      await tx.query(
        `INSERT INTO user_skills (user_id, skill_id, company_id, level, source) VALUES ($1,$2,$3,$4,'course')
         ON DUPLICATE KEY UPDATE source = IF(VALUES(level) >= level, 'course', source), level = GREATEST(level, VALUES(level))`,
        [enrolment.user_id, s.skill_id, companyId, s.level]);
    }
  });
  await notifications.create({
    companyId, userId: enrolment.user_id, type: 'course.completed', title: `Completed: ${course.title}`,
    body: course.certification_name ? `Certification issued: ${course.certification_name}` : undefined, link: `/academy/courses/${course.id}`,
    resourceType: 'course', resourceId: course.id, dedupeKey: `course.completed:${enrolment.id}:${now.toISOString().slice(0, 10)}`,
  });
}

export async function completeLesson(actor: Actor, courseId: string, lessonId: string) {
  const c = await loadCourse(actor, courseId);
  const e = await myEnrolment(actor, courseId);
  if (!(await one('SELECT 1 FROM course_lessons WHERE id = $1 AND course_id = $2', [lessonId, courseId]))) throw notFound('Lesson not found');
  await pool.query('INSERT IGNORE INTO lesson_progress (enrolment_id, lesson_id) VALUES ($1,$2)', [e.id, lessonId]);
  await completeIfDone(actor.companyId, c, e);
  return getCourse(actor, courseId);
}

export async function submitQuiz(actor: Actor, courseId: string, answers: (number | null)[]) {
  const c = await loadCourse(actor, courseId);
  if (c.pass_mark === null) throw conflict('This course has no quiz');
  const e = await myEnrolment(actor, courseId);
  if (e.status === 'completed') throw conflict('You have already completed this course');
  const questions = await many<{ correct_index: number }>('SELECT correct_index FROM course_questions WHERE course_id = $1 ORDER BY position', [courseId]);
  if (answers.length !== questions.length) throw unprocessable('Answer every question', [{ field: 'answers', message: `Expected ${questions.length} answers` }]);
  const { score, passed } = markQuiz(questions.map((q) => q.correct_index), answers, c.pass_mark);
  await pool.query('INSERT INTO quiz_attempts (id, enrolment_id, score, passed, answers) VALUES ($1,$2,$3,$4,$5)', [newId(), e.id, score, passed, JSON.stringify(answers)]);
  await pool.query('UPDATE enrolments SET attempts = attempts + 1, score = GREATEST(COALESCE(score, 0), $2) WHERE id = $1', [e.id, score]);
  await completeIfDone(actor.companyId, c, e);
  return { score, passed, passMark: c.pass_mark, course: await getCourse(actor, courseId) };
}

/** Starts a completed course again, for someone whose certification has lapsed or is about to. */
export async function restart(actor: Actor, courseId: string) {
  await loadCourse(actor, courseId);
  const e = await myEnrolment(actor, courseId);
  if (e.status !== 'completed') throw conflict('This course is still in progress');
  const cert = await one<{ expires_at: Date | null }>('SELECT expires_at FROM certifications WHERE user_id = $1 AND course_id = $2 ORDER BY issued_at DESC LIMIT 1', [actor.userId, courseId]);
  if (!cert?.expires_at || new Date(cert.expires_at).getTime() - Date.now() > 60 * DAY) throw conflict('You can retake this course within 60 days of your certification expiring');
  await transaction(async (tx) => {
    await tx.query('DELETE FROM lesson_progress WHERE enrolment_id = $1', [e.id]);
    await tx.query("UPDATE enrolments SET status = 'in_progress', completed_at = NULL, score = NULL, started_at = NOW(3) WHERE id = $1", [e.id]);
  });
  return getCourse(actor, courseId);
}

/** Who has done what, for the people running training. */
export async function trainingReport(actor: Actor, courseId: string) {
  await requireManage(actor);
  await loadCourse(actor, courseId);
  const rows = await many<{ user_id: string; display_name: string; status: string; source: string; due_at: Date | null; completed_at: Date | null; score: number | null; attempts: number; lessons_done: number }>(
    `SELECT e.user_id, u.display_name, e.status, e.source, e.due_at, e.completed_at, e.score, e.attempts,
            (SELECT COUNT(*) FROM lesson_progress p WHERE p.enrolment_id = e.id) AS lessons_done
       FROM enrolments e JOIN users u ON u.id = e.user_id WHERE e.course_id = $1
      ORDER BY (e.status = 'completed'), e.due_at IS NULL, e.due_at, u.display_name`, [courseId]);
  const now = Date.now();
  return {
    items: rows.map((r) => ({ userId: r.user_id, name: r.display_name, status: r.status, source: r.source, dueAt: r.due_at, completedAt: r.completed_at, score: r.score, attempts: Number(r.attempts), lessonsDone: Number(r.lessons_done), overdue: r.status !== 'completed' && r.due_at !== null && new Date(r.due_at).getTime() < now })),
  };
}

/* ----------------------------------------------------------- certifications */

export async function listCertifications(actor: Actor, filter: { scope: 'mine' | 'all'; expiringDays?: number }) {
  await requireLearn(actor);
  if (filter.scope === 'all') await requireManage(actor);
  const params: unknown[] = [actor.companyId];
  const where = ['c.company_id = $1'];
  if (filter.scope === 'mine') { params.push(actor.userId); where.push(`c.user_id = $${params.length}`); }
  if (filter.expiringDays) { params.push(new Date(Date.now() + filter.expiringDays * DAY)); where.push(`c.expires_at IS NOT NULL AND c.expires_at <= $${params.length}`); }
  const rows = await many<{ id: string; user_id: string; display_name: string; course_id: string | null; name: string; issuer: string | null; credential_url: string | null; issued_at: Date; expires_at: Date | null; source: string; verified_by_name: string | null; verified_at: Date | null }>(
    `SELECT c.*, u.display_name, v.display_name AS verified_by_name FROM certifications c JOIN users u ON u.id = c.user_id LEFT JOIN users v ON v.id = c.verified_by
      WHERE ${where.join(' AND ')} ORDER BY c.expires_at IS NULL, c.expires_at, c.issued_at DESC LIMIT 500`, params);
  const now = Date.now();
  return rows.map((c) => ({
    id: c.id, user: { id: c.user_id, name: c.display_name }, courseId: c.course_id, name: c.name, issuer: c.issuer, credentialUrl: c.credential_url,
    issuedAt: c.issued_at, expiresAt: c.expires_at, source: c.source, verified: c.source === 'course' || c.verified_at !== null, verifiedBy: c.verified_by_name,
    state: c.expires_at && new Date(c.expires_at).getTime() < now ? 'expired' : c.expires_at && new Date(c.expires_at).getTime() - now < 30 * DAY ? 'expiring' : 'valid',
  }));
}

export async function addExternalCertification(actor: Actor, input: { name: string; issuer?: string | null; credentialUrl?: string | null; issuedAt: string; expiresAt?: string | null }) {
  await requireLearn(actor);
  const issued = new Date(input.issuedAt);
  const expires = input.expiresAt ? new Date(input.expiresAt) : null;
  if (issued.getTime() > Date.now() + DAY) throw unprocessable('A certification cannot be issued in the future', [{ field: 'issuedAt', message: 'Check the date' }]);
  if (expires && expires <= issued) throw unprocessable('It must expire after it was issued', [{ field: 'expiresAt', message: 'Check the date' }]);
  const id = newId();
  await pool.query('INSERT INTO certifications (id, company_id, user_id, name, issuer, credential_url, issued_at, expires_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'external\')',
    [id, actor.companyId, actor.userId, input.name.trim(), input.issuer?.trim() || null, httpUrl(input.credentialUrl, 'credentialUrl'), issued, expires]);
  await auditFromActor(actor, 'certification.add', { resourceType: 'certification', resourceId: id });
  return { id };
}

export async function verifyCertification(actor: Actor, id: string) {
  await requireManage(actor);
  const c = await one<{ user_id: string; source: string; verified_at: Date | null }>('SELECT user_id, source, verified_at FROM certifications WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!c) throw notFound('Certification not found');
  if (c.user_id === actor.userId) throw forbidden('Someone else must verify your own certification');
  if (c.source !== 'external' || c.verified_at) throw conflict('This certification does not need verifying');
  await pool.query('UPDATE certifications SET verified_by = $2, verified_at = NOW(3) WHERE id = $1', [id, actor.userId]);
  await auditFromActor(actor, 'certification.verify', { resourceType: 'certification', resourceId: id, metadata: { userId: c.user_id } });
}

export async function removeCertification(actor: Actor, id: string) {
  await requireLearn(actor);
  const c = await one<{ user_id: string; source: string; verified_at: Date | null }>('SELECT user_id, source, verified_at FROM certifications WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!c) throw notFound('Certification not found');
  const own = c.user_id === actor.userId && c.source === 'external' && !c.verified_at;
  if (!own && !hasCapability(actor, 'academy.manage')) throw forbidden('Only unverified certifications you added yourself can be removed');
  await pool.query('DELETE FROM certifications WHERE id = $1', [id]);
  await auditFromActor(actor, 'certification.remove', { resourceType: 'certification', resourceId: id, metadata: { userId: c.user_id } });
}

/* ------------------------------------------------------------------ skills */

export async function listSkills(actor: Actor) {
  await requireLearn(actor);
  const rows = await many<{ id: string; name: string; category: string | null; description: string | null; people: number; experts: number; my_level: number | null; my_verified: Date | null; my_source: string | null }>(
    `SELECT s.*, (SELECT COUNT(*) FROM user_skills us JOIN users u ON u.id = us.user_id WHERE us.skill_id = s.id AND u.status = 'active') AS people,
            (SELECT COUNT(*) FROM user_skills us JOIN users u ON u.id = us.user_id WHERE us.skill_id = s.id AND us.level >= 3 AND u.status = 'active') AS experts,
            mine.level AS my_level, mine.verified_at AS my_verified, mine.source AS my_source
       FROM skills s LEFT JOIN user_skills mine ON mine.skill_id = s.id AND mine.user_id = $2
      WHERE s.company_id = $1 ORDER BY s.category IS NULL, s.category, s.name`, [actor.companyId, actor.userId]);
  return rows.map((s) => ({ id: s.id, name: s.name, category: s.category, description: s.description, people: Number(s.people), experts: Number(s.experts), mine: s.my_level ? { level: s.my_level, source: s.my_source, verified: s.my_source === 'course' || s.my_verified !== null } : null }));
}

export async function saveSkill(actor: Actor, id: string | null, input: { name: string; category?: string | null; description?: string | null }) {
  await requireManage(actor);
  if (await one('SELECT 1 FROM skills WHERE company_id = $1 AND name = $2 AND id <> $3', [actor.companyId, input.name.trim(), id ?? ''])) throw conflict('A skill with that name already exists');
  const skillId = id ?? newId();
  if (id) {
    const res = await pool.query('UPDATE skills SET name = $3, category = $4, description = $5 WHERE id = $1 AND company_id = $2', [id, actor.companyId, input.name.trim(), input.category?.trim() || null, input.description?.trim() || null]);
    if (res.rowCount === 0) throw notFound('Skill not found');
  } else {
    await pool.query('INSERT INTO skills (id, company_id, name, category, description) VALUES ($1,$2,$3,$4,$5)', [skillId, actor.companyId, input.name.trim(), input.category?.trim() || null, input.description?.trim() || null]);
  }
  await auditFromActor(actor, id ? 'skill.update' : 'skill.create', { resourceType: 'skill', resourceId: skillId });
  return { id: skillId };
}

/** Someone's own assessment. Changing it clears any earlier confirmation. */
export async function setMySkill(actor: Actor, skillId: string, level: number | null) {
  await requireLearn(actor);
  if (!(await one('SELECT 1 FROM skills WHERE id = $1 AND company_id = $2', [skillId, actor.companyId]))) throw notFound('Skill not found');
  if (level === null) await pool.query('DELETE FROM user_skills WHERE user_id = $1 AND skill_id = $2', [actor.userId, skillId]);
  else {
    await pool.query(
      `INSERT INTO user_skills (user_id, skill_id, company_id, level, source) VALUES ($1,$2,$3,$4,'self')
       ON DUPLICATE KEY UPDATE verified_by = IF(level = VALUES(level), verified_by, NULL), verified_at = IF(level = VALUES(level), verified_at, NULL),
         source = IF(level = VALUES(level), source, 'self'), level = VALUES(level)`,
      [actor.userId, skillId, actor.companyId, level]);
  }
}

export async function skillHolders(actor: Actor, skillId: string) {
  await requireLearn(actor);
  if (!(await one('SELECT 1 FROM skills WHERE id = $1 AND company_id = $2', [skillId, actor.companyId]))) throw notFound('Skill not found');
  const rows = await many<{ user_id: string; display_name: string; manager_id: string | null; level: number; source: string; verified_at: Date | null; verified_by_name: string | null }>(
    `SELECT us.user_id, u.display_name, u.manager_id, us.level, us.source, us.verified_at, v.display_name AS verified_by_name
       FROM user_skills us JOIN users u ON u.id = us.user_id LEFT JOIN users v ON v.id = us.verified_by
      WHERE us.skill_id = $1 AND u.status = 'active' ORDER BY us.level DESC, u.display_name`, [skillId]);
  const manage = hasCapability(actor, 'academy.manage');
  return rows.map((r) => ({
    userId: r.user_id, name: r.display_name, level: r.level, source: r.source, verified: r.source === 'course' || r.verified_at !== null, verifiedBy: r.verified_by_name,
    canVerify: r.user_id !== actor.userId && r.source === 'self' && !r.verified_at && (manage || r.manager_id === actor.userId),
  }));
}

/** A manager (or academy manager) confirms a self-assessed level. */
export async function verifySkill(actor: Actor, userId: string, skillId: string) {
  await requireLearn(actor);
  if (userId === actor.userId) throw forbidden('Someone else must confirm your own skills');
  const row = await one<{ manager_id: string | null; source: string }>(
    'SELECT u.manager_id, us.source FROM user_skills us JOIN users u ON u.id = us.user_id WHERE us.user_id = $1 AND us.skill_id = $2 AND us.company_id = $3', [userId, skillId, actor.companyId]);
  if (!row) throw notFound('Skill not recorded for this person');
  if (row.manager_id !== actor.userId && !hasCapability(actor, 'academy.manage')) throw forbidden('Only their manager or an academy manager can confirm this');
  await pool.query("UPDATE user_skills SET verified_by = $3, verified_at = NOW(3), source = 'manager' WHERE user_id = $1 AND skill_id = $2", [userId, skillId, actor.userId]);
  await auditFromActor(actor, 'skill.verify', { resourceType: 'user', resourceId: userId, metadata: { skillId } });
}

/* ---------------------------------------------------------------- policies */

type PolicyRow = { id: string; company_id: string; title: string; category: string | null; status: 'draft' | 'published' | 'retired'; current_version: number | null; audience_group_id: string | null; ack_due_days: number; owner_id: string | null; draft_body: string | null; updated_at: Date };

async function inAudience(companyId: string, policy: PolicyRow, userId: string) {
  if (!policy.audience_group_id) return true;
  return Boolean(await one('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [policy.audience_group_id, userId]));
}

async function audience(companyId: string, policy: PolicyRow) {
  return policy.audience_group_id
    ? many<{ id: string; display_name: string }>("SELECT u.id, u.display_name FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 AND u.status = 'active' AND u.access_level <> 'guest' ORDER BY u.display_name", [policy.audience_group_id])
    : many<{ id: string; display_name: string }>("SELECT id, display_name FROM users WHERE company_id = $1 AND status = 'active' AND access_level <> 'guest' ORDER BY display_name", [companyId]);
}

export async function listPolicies(actor: Actor) {
  await requireLearn(actor);
  const manage = hasCapability(actor, 'policy.manage');
  const rows = await many<PolicyRow & { version_id: string | null; published_at: Date | null; acked_at: Date | null; group_name: string | null; member: number }>(
    `SELECT p.*, v.id AS version_id, v.published_at, a.acknowledged_at AS acked_at, g.name AS group_name,
            (p.audience_group_id IS NULL OR EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = p.audience_group_id AND m.user_id = $2)) AS member
       FROM policies p
       LEFT JOIN policy_versions v ON v.policy_id = p.id AND v.version = p.current_version
       LEFT JOIN policy_acknowledgements a ON a.version_id = v.id AND a.user_id = $2
       LEFT JOIN \`groups\` g ON g.id = p.audience_group_id
      WHERE p.company_id = $1 ${manage ? '' : "AND p.status = 'published'"} ORDER BY FIELD(p.status,'published','draft','retired'), p.title`, [actor.companyId, actor.userId]);
  const now = Date.now();
  return rows.filter((p) => manage || Boolean(Number(p.member))).map((p) => {
    const due = p.published_at ? new Date(new Date(p.published_at).getTime() + p.ack_due_days * DAY) : null;
    return {
      id: p.id, title: p.title, category: p.category, status: p.status, version: p.current_version, publishedAt: p.published_at, audience: p.group_name ?? 'Everyone',
      appliesToMe: Boolean(Number(p.member)) && p.status === 'published', acknowledgedAt: p.acked_at, dueAt: due,
      overdue: Boolean(Number(p.member)) && p.status === 'published' && !p.acked_at && due !== null && due.getTime() < now,
    };
  });
}

export async function getPolicy(actor: Actor, id: string) {
  await requireLearn(actor);
  const manage = hasCapability(actor, 'policy.manage');
  const p = await one<PolicyRow>('SELECT * FROM policies WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!p || (!manage && (p.status !== 'published' || !(await inAudience(actor.companyId, p, actor.userId))))) throw notFound('Policy not found');
  const versions = await many<{ id: string; version: number; body: string; change_note: string | null; published_at: Date; publisher: string | null }>(
    'SELECT v.id, v.version, v.body, v.change_note, v.published_at, u.display_name AS publisher FROM policy_versions v LEFT JOIN users u ON u.id = v.published_by WHERE v.policy_id = $1 ORDER BY v.version DESC', [id]);
  const current = versions.find((v) => v.version === p.current_version) ?? null;
  const ack = current ? await one<{ acknowledged_at: Date }>('SELECT acknowledged_at FROM policy_acknowledgements WHERE version_id = $1 AND user_id = $2', [current.id, actor.userId]) : null;
  return {
    id: p.id, title: p.title, category: p.category, status: p.status, audienceGroupId: p.audience_group_id, ackDueDays: p.ack_due_days, ownerId: p.owner_id,
    current: current ? { version: current.version, body: current.body, changeNote: current.change_note, publishedAt: current.published_at, publishedBy: current.publisher } : null,
    acknowledgedAt: ack?.acknowledged_at ?? null,
    draftBody: manage ? p.draft_body : undefined,
    history: manage ? versions.map((v) => ({ version: v.version, changeNote: v.change_note, publishedAt: v.published_at, publishedBy: v.publisher })) : undefined,
    permissions: { canManage: manage, mustAcknowledge: p.status === 'published' && !ack && current !== null && (await inAudience(actor.companyId, p, actor.userId)) },
  };
}

export async function savePolicy(actor: Actor, id: string | null, input: { title: string; category?: string | null; audienceGroupId?: string | null; ackDueDays: number; ownerId?: string | null; draftBody: string }) {
  await authorize({ actor, capability: 'policy.manage', resourceless: true });
  if (input.audienceGroupId && !(await one('SELECT 1 FROM `groups` WHERE id = $1 AND company_id = $2', [input.audienceGroupId, actor.companyId]))) throw unprocessable('Group not found', [{ field: 'audienceGroupId', message: 'Choose a group' }]);
  const policyId = id ?? newId();
  const values = [input.title.trim(), input.category?.trim() || null, input.audienceGroupId ?? null, input.ackDueDays, input.ownerId ?? null, input.draftBody];
  if (id) {
    const res = await pool.query('UPDATE policies SET title = $3, category = $4, audience_group_id = $5, ack_due_days = $6, owner_id = $7, draft_body = $8 WHERE id = $1 AND company_id = $2', [id, actor.companyId, ...values]);
    if (res.rowCount === 0) throw notFound('Policy not found');
  } else {
    await pool.query('INSERT INTO policies (id, company_id, title, category, audience_group_id, ack_due_days, owner_id, draft_body, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [policyId, actor.companyId, ...values, actor.userId]);
  }
  await auditFromActor(actor, id ? 'policy.update' : 'policy.create', { resourceType: 'policy', resourceId: policyId });
  return { id: policyId };
}

export async function publishPolicy(actor: Actor, id: string, changeNote: string | null) {
  await authorize({ actor, capability: 'policy.manage', resourceless: true });
  const p = await one<PolicyRow>('SELECT * FROM policies WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!p) throw notFound('Policy not found');
  if (!p.draft_body?.trim()) throw unprocessable('Write the policy before publishing it');
  const last = p.current_version ? await one<{ body: string }>('SELECT body FROM policy_versions WHERE policy_id = $1 AND version = $2', [id, p.current_version]) : null;
  if (last && last.body === p.draft_body && p.status === 'published') throw conflict('Nothing has changed since the last published version');
  const version = (p.current_version ?? 0) + 1;
  await transaction(async (tx) => {
    await tx.query('INSERT INTO policy_versions (id, policy_id, version, body, change_note, published_by) VALUES ($1,$2,$3,$4,$5,$6)', [newId(), id, version, p.draft_body, changeNote?.trim() || null, actor.userId]);
    await tx.query("UPDATE policies SET status = 'published', current_version = $2 WHERE id = $1", [id, version]);
    await auditFromActor(actor, 'policy.publish', { resourceType: 'policy', resourceId: id, metadata: { version } }, tx);
  });
  await searchIndex.index({
    companyId: actor.companyId, docType: 'policy', resourceId: id, title: p.title, body: `${p.title} ${p.category ?? ''} ${p.draft_body}`,
    aclCompanyWide: !p.audience_group_id, aclGroupIds: p.audience_group_id ? [p.audience_group_id] : [], link: `/academy/policies/${id}`,
  });
  for (const u of await audience(actor.companyId, p)) {
    await notifications.create({
      companyId: actor.companyId, userId: u.id, type: 'policy.published', title: version === 1 ? `New policy to read: ${p.title}` : `Updated policy to read: ${p.title}`,
      body: `Acknowledge within ${p.ack_due_days} days`, link: `/academy/policies/${id}`, resourceType: 'policy', resourceId: id, dedupeKey: `policy.published:${id}:${version}:${u.id}`,
    });
  }
  return { version };
}

export async function retirePolicy(actor: Actor, id: string) {
  await authorize({ actor, capability: 'policy.manage', resourceless: true });
  const res = await pool.query("UPDATE policies SET status = 'retired' WHERE id = $1 AND company_id = $2 AND status = 'published'", [id, actor.companyId]);
  if (res.rowCount === 0) throw conflict('Only a published policy can be retired');
  await searchIndex.remove('policy', id);
  await auditFromActor(actor, 'policy.retire', { resourceType: 'policy', resourceId: id });
}

export async function acknowledgePolicy(actor: Actor, id: string, ip: string | null) {
  await requireLearn(actor);
  const p = await one<PolicyRow>('SELECT * FROM policies WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!p || p.status !== 'published' || !(await inAudience(actor.companyId, p, actor.userId))) throw notFound('Policy not found');
  const v = await one<{ id: string }>('SELECT id FROM policy_versions WHERE policy_id = $1 AND version = $2', [id, p.current_version]);
  const res = await pool.query('INSERT IGNORE INTO policy_acknowledgements (version_id, user_id, company_id, ip) VALUES ($1,$2,$3,$4)', [v!.id, actor.userId, actor.companyId, ip]);
  if (res.rowCount) await auditFromActor(actor, 'policy.acknowledge', { resourceType: 'policy', resourceId: id, metadata: { version: p.current_version } });
  return getPolicy(actor, id);
}

export async function policyCoverage(actor: Actor, id: string) {
  await authorize({ actor, capability: 'policy.manage', resourceless: true });
  const p = await one<PolicyRow>('SELECT * FROM policies WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!p) throw notFound('Policy not found');
  const people = await audience(actor.companyId, p);
  const v = p.current_version ? await one<{ id: string; published_at: Date }>('SELECT id, published_at FROM policy_versions WHERE policy_id = $1 AND version = $2', [id, p.current_version]) : null;
  const acks = v ? await many<{ user_id: string; acknowledged_at: Date }>('SELECT user_id, acknowledged_at FROM policy_acknowledgements WHERE version_id = $1', [v.id]) : [];
  const due = v ? new Date(new Date(v.published_at).getTime() + p.ack_due_days * DAY) : null;
  const items = people.map((u) => ({ userId: u.id, name: u.display_name, acknowledgedAt: acks.find((a) => a.user_id === u.id)?.acknowledged_at ?? null }));
  return { version: p.current_version, dueAt: due, total: items.length, acknowledged: items.filter((i) => i.acknowledgedAt).length, overdue: due !== null && due.getTime() < Date.now(), items };
}

/* --------------------------------------------------------- summary and jobs */

export async function myLearning(actor: Actor) {
  await requireLearn(actor);
  const enrolments = await many<{ course_id: string; title: string; status: string; due_at: Date | null; lessons: number; done: number; completed_at: Date | null }>(
    `SELECT e.course_id, c.title, e.status, e.due_at, e.completed_at,
            (SELECT COUNT(*) FROM course_lessons l WHERE l.course_id = c.id) AS lessons,
            (SELECT COUNT(*) FROM lesson_progress p WHERE p.enrolment_id = e.id) AS done
       FROM enrolments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = $1 AND c.status <> 'archived'
      ORDER BY e.status = 'completed', e.due_at IS NULL, e.due_at, c.title`, [actor.userId]);
  const policies = (await listPolicies(actor)).filter((p) => p.appliesToMe && !p.acknowledgedAt);
  const certifications = (await listCertifications(actor, { scope: 'mine' })).filter((c) => c.state !== 'valid');
  const now = Date.now();
  return {
    courses: enrolments.map((e) => ({ courseId: e.course_id, title: e.title, status: e.status, dueAt: e.due_at, completedAt: e.completed_at, lessons: Number(e.lessons), lessonsDone: Number(e.done), overdue: e.status !== 'completed' && e.due_at !== null && new Date(e.due_at).getTime() < now })),
    policiesToAcknowledge: policies.map((p) => ({ id: p.id, title: p.title, dueAt: p.dueAt, overdue: p.overdue })),
    certificationsNeedingAttention: certifications.map((c) => ({ id: c.id, name: c.name, expiresAt: c.expiresAt, state: c.state, courseId: c.courseId })),
  };
}

/** Reminders for training due soon, certifications expiring and policies not yet acknowledged. */
export async function sendReminders(): Promise<void> {
  const dueSoon = await many<{ id: string; company_id: string; user_id: string; course_id: string; title: string; due_at: Date }>(
    `SELECT e.id, e.company_id, e.user_id, e.course_id, c.title, e.due_at FROM enrolments e JOIN courses c ON c.id = e.course_id
      WHERE e.status = 'in_progress' AND e.due_at IS NOT NULL AND e.due_at < DATE_ADD(NOW(3), INTERVAL 3 DAY)
        AND (e.reminded_at IS NULL OR e.reminded_at < DATE_SUB(NOW(3), INTERVAL 2 DAY)) AND c.status = 'published' LIMIT 500`);
  for (const e of dueSoon) {
    const overdue = new Date(e.due_at).getTime() < Date.now();
    await notifications.create({ companyId: e.company_id, userId: e.user_id, type: 'course.due', title: overdue ? `Training overdue: ${e.title}` : `Training due soon: ${e.title}`, link: `/academy/courses/${e.course_id}`, resourceType: 'course', resourceId: e.course_id, dedupeKey: `course.due:${e.id}:${new Date().toISOString().slice(0, 10)}` });
    await pool.query('UPDATE enrolments SET reminded_at = NOW(3) WHERE id = $1', [e.id]);
  }
  const expiring = await many<{ id: string; company_id: string; user_id: string; name: string; expires_at: Date; course_id: string | null }>(
    `SELECT id, company_id, user_id, name, expires_at, course_id FROM certifications
      WHERE expires_at IS NOT NULL AND expires_at < DATE_ADD(NOW(3), INTERVAL 30 DAY) AND reminded_at IS NULL LIMIT 500`);
  for (const c of expiring) {
    await notifications.create({ companyId: c.company_id, userId: c.user_id, type: 'certification.expiring', title: `${c.name} expires ${new Date(c.expires_at).toISOString().slice(0, 10)}`, link: c.course_id ? `/academy/courses/${c.course_id}` : '/academy/certifications', resourceType: 'certification', resourceId: c.id, dedupeKey: `certification.expiring:${c.id}` });
    await pool.query('UPDATE certifications SET reminded_at = NOW(3) WHERE id = $1', [c.id]);
  }
  const policies = await many<PolicyRow & { version_id: string; published_at: Date }>(
    `SELECT p.*, v.id AS version_id, v.published_at FROM policies p JOIN policy_versions v ON v.policy_id = p.id AND v.version = p.current_version
      WHERE p.status = 'published' AND v.published_at < DATE_SUB(NOW(3), INTERVAL p.ack_due_days DAY)`);
  for (const p of policies) {
    for (const u of await audience(p.company_id, p)) {
      if (await one('SELECT 1 FROM policy_acknowledgements WHERE version_id = $1 AND user_id = $2', [p.version_id, u.id])) continue;
      // One reminder a week per person per version.
      const week = Math.floor(Date.now() / (7 * DAY));
      await notifications.create({ companyId: p.company_id, userId: u.id, type: 'policy.overdue', title: `Please acknowledge: ${p.title}`, link: `/academy/policies/${p.id}`, resourceType: 'policy', resourceId: p.id, dedupeKey: `policy.overdue:${p.version_id}:${u.id}:${week}` });
    }
  }
}

/** Ownership moves to a successor when someone leaves. */
export async function transferOwnership(companyId: string, fromUserId: string, toUserId: string, db: Queryable = pool) {
  const courses = await db.query('UPDATE courses SET owner_id = $3 WHERE company_id = $1 AND owner_id = $2', [companyId, fromUserId, toUserId]);
  const policies = await db.query('UPDATE policies SET owner_id = $3 WHERE company_id = $1 AND owner_id = $2', [companyId, fromUserId, toUserId]);
  return { courses: courses.rowCount ?? 0, policies: policies.rowCount ?? 0 };
}

/* ------------------------------------------------------------------ deletion */

/** A course nobody has started can be deleted; once people have progress or certifications, archive it. */
export async function deleteCourse(actor: Actor, id: string) {
  await requireManage(actor);
  const c = await loadCourse(actor, id);
  const started = await one<{ n: number }>('SELECT COUNT(*) AS n FROM enrolments WHERE course_id = $1', [id]);
  if (Number(started?.n)) throw conflict(`${started!.n} ${Number(started!.n) === 1 ? 'person has' : 'people have'} started this course. Archive it instead so their records stay.`);
  if (await one('SELECT 1 FROM access_resources WHERE required_course_id = $1', [id])) throw conflict('A system in the access catalogue requires this course. Change that first.');
  await pool.query('DELETE FROM courses WHERE id = $1', [id]);
  await searchIndex.remove('course', id);
  await auditFromActor(actor, 'course.delete', { resourceType: 'course', resourceId: id, metadata: { title: c.title } });
}

/** Deleting a skill removes it from everyone's record and from the courses that teach it. */
export async function deleteSkill(actor: Actor, id: string) {
  await requireManage(actor);
  const s = await one<{ name: string; holders: number }>('SELECT name, (SELECT COUNT(*) FROM user_skills WHERE skill_id = $1) AS holders FROM skills WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!s) throw notFound('Skill not found');
  await pool.query('DELETE FROM skills WHERE id = $1', [id]);
  await auditFromActor(actor, 'skill.delete', { resourceType: 'skill', resourceId: id, metadata: { name: s.name, holders: Number(s.holders) } });
}

/** Only a policy that was never published can be deleted; published text people acknowledged is retired instead. */
export async function deletePolicy(actor: Actor, id: string) {
  await authorize({ actor, capability: 'policy.manage', resourceless: true });
  const p = await one<{ title: string; current_version: number | null }>('SELECT title, current_version FROM policies WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!p) throw notFound('Policy not found');
  if (p.current_version !== null) throw conflict('This policy has been published. Retire it instead so acknowledgements stay on record.');
  await pool.query('DELETE FROM policies WHERE id = $1', [id]);
  await auditFromActor(actor, 'policy.delete', { resourceType: 'policy', resourceId: id, metadata: { title: p.title } });
}
