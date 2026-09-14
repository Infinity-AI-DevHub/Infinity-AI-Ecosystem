/**
 * Academy routes: courses, lessons, quizzes, enrolments, certifications, skills and policies.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as academy from '../../domains/academy.js';

const idParam = z.object({ id: z.string().uuid() });
const dateTime = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}.*)?$/));

const courseBody = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z.string().max(500).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  passMark: z.number().int().min(1).max(100).nullable().optional(),
  certificationName: z.string().max(160).nullable().optional(),
  validityMonths: z.number().int().min(1).max(120).nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  skills: z.array(z.object({ skillId: z.string().uuid(), level: z.number().int().min(1).max(4) })).max(20).optional(),
});

const lessonBody = z.object({
  title: z.string().trim().min(2).max(200),
  body: z.string().min(1).max(200_000),
  videoUrl: z.string().max(500).nullable().optional(),
  minutes: z.number().int().min(1).max(600),
  position: z.number().int().min(0).max(1000).optional(),
});

const policyBody = z.object({
  title: z.string().trim().min(3).max(200),
  category: z.string().max(60).nullable().optional(),
  audienceGroupId: z.string().uuid().nullable().optional(),
  ackDueDays: z.number().int().min(1).max(365),
  ownerId: z.string().uuid().nullable().optional(),
  draftBody: z.string().max(200_000),
});

export async function academyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/academy/me', async (request) => academy.myLearning(requireActor(request)));

  /* ----------------------------------------------------------------- courses */

  app.get('/academy/courses', async (request) => {
    const q = parse(z.object({ q: z.string().max(200).optional(), status: z.enum(['draft', 'published', 'archived']).optional(), category: z.string().max(60).optional() }), request.query);
    return { items: await academy.listCourses(requireActor(request), q) };
  });
  app.post('/academy/courses', async (request, reply) => {
    reply.code(201);
    return academy.saveCourse(requireActor(request), null, parse(courseBody, request.body));
  });
  app.get('/academy/courses/:id', async (request) => academy.getCourse(requireActor(request), parse(idParam, request.params).id));
  app.put('/academy/courses/:id', async (request) => academy.saveCourse(requireActor(request), parse(idParam, request.params).id, parse(courseBody, request.body)));
  app.post('/academy/courses/:id/status', async (request, reply) => {
    const { status } = parse(z.object({ status: z.enum(['draft', 'published', 'archived']) }), request.body);
    await academy.setCourseStatus(requireActor(request), parse(idParam, request.params).id, status);
    reply.code(204);
  });
  app.post('/academy/courses/:id/lessons', async (request, reply) => {
    reply.code(201);
    return academy.saveLesson(requireActor(request), parse(idParam, request.params).id, null, parse(lessonBody, request.body));
  });
  app.put('/academy/courses/:id/lessons/:lessonId', async (request) => {
    const { id, lessonId } = parse(z.object({ id: z.string().uuid(), lessonId: z.string().uuid() }), request.params);
    return academy.saveLesson(requireActor(request), id, lessonId, parse(lessonBody, request.body));
  });
  app.delete('/academy/courses/:id/lessons/:lessonId', async (request, reply) => {
    const { id, lessonId } = parse(z.object({ id: z.string().uuid(), lessonId: z.string().uuid() }), request.params);
    await academy.deleteLesson(requireActor(request), id, lessonId);
    reply.code(204);
  });
  app.put('/academy/courses/:id/questions', async (request, reply) => {
    const { questions } = parse(z.object({ questions: z.array(z.object({ prompt: z.string().trim().min(3).max(500), options: z.array(z.string().trim().min(1).max(300)).min(2).max(6), correctIndex: z.number().int().min(0).max(5) })).max(50) }), request.body);
    await academy.saveQuestions(requireActor(request), parse(idParam, request.params).id, questions);
    reply.code(204);
  });
  app.post('/academy/courses/:id/assign', async (request) => {
    const input = parse(z.object({ userIds: z.array(z.string().uuid()).max(500).optional(), groupId: z.string().uuid().nullable().optional(), dueAt: dateTime.nullable().optional() }), request.body);
    return academy.assign(requireActor(request), parse(idParam, request.params).id, input);
  });
  app.get('/academy/courses/:id/report', async (request) => academy.trainingReport(requireActor(request), parse(idParam, request.params).id));

  app.post('/academy/courses/:id/enrol', async (request) => academy.enrol(requireActor(request), parse(idParam, request.params).id));
  app.post('/academy/courses/:id/lessons/:lessonId/complete', async (request) => {
    const { id, lessonId } = parse(z.object({ id: z.string().uuid(), lessonId: z.string().uuid() }), request.params);
    return academy.completeLesson(requireActor(request), id, lessonId);
  });
  app.post('/academy/courses/:id/quiz', async (request) => {
    const { answers } = parse(z.object({ answers: z.array(z.number().int().min(0).max(5).nullable()).max(50) }), request.body);
    return academy.submitQuiz(requireActor(request), parse(idParam, request.params).id, answers);
  });
  app.post('/academy/courses/:id/restart', async (request) => academy.restart(requireActor(request), parse(idParam, request.params).id));

  app.delete('/academy/courses/:id', async (request, reply) => {
    await academy.deleteCourse(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/academy/skills/:id', async (request, reply) => {
    await academy.deleteSkill(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/academy/policies/:id', async (request, reply) => {
    await academy.deletePolicy(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  /* ---------------------------------------------------------- certifications */

  app.get('/academy/certifications', async (request) => {
    const q = parse(z.object({ scope: z.enum(['mine', 'all']).default('mine'), expiringDays: z.coerce.number().int().min(1).max(365).optional() }), request.query);
    return { items: await academy.listCertifications(requireActor(request), q) };
  });
  app.post('/academy/certifications', async (request, reply) => {
    const input = parse(z.object({ name: z.string().trim().min(2).max(160), issuer: z.string().max(120).nullable().optional(), credentialUrl: z.string().max(500).nullable().optional(), issuedAt: dateTime, expiresAt: dateTime.nullable().optional() }), request.body);
    reply.code(201);
    return academy.addExternalCertification(requireActor(request), input);
  });
  app.post('/academy/certifications/:id/verify', async (request, reply) => {
    await academy.verifyCertification(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.delete('/academy/certifications/:id', async (request, reply) => {
    await academy.removeCertification(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });

  /* ------------------------------------------------------------------ skills */

  const skillBody = z.object({ name: z.string().trim().min(2).max(80), category: z.string().max(60).nullable().optional(), description: z.string().max(300).nullable().optional() });
  app.get('/academy/skills', async (request) => ({ items: await academy.listSkills(requireActor(request)) }));
  app.post('/academy/skills', async (request, reply) => {
    reply.code(201);
    return academy.saveSkill(requireActor(request), null, parse(skillBody, request.body));
  });
  app.put('/academy/skills/:id', async (request) => academy.saveSkill(requireActor(request), parse(idParam, request.params).id, parse(skillBody, request.body)));
  app.put('/academy/skills/:id/mine', async (request, reply) => {
    const { level } = parse(z.object({ level: z.number().int().min(1).max(4).nullable() }), request.body);
    await academy.setMySkill(requireActor(request), parse(idParam, request.params).id, level);
    reply.code(204);
  });
  app.get('/academy/skills/:id/people', async (request) => ({ items: await academy.skillHolders(requireActor(request), parse(idParam, request.params).id) }));
  app.post('/academy/skills/:id/people/:userId/verify', async (request, reply) => {
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), request.params);
    await academy.verifySkill(requireActor(request), userId, id);
    reply.code(204);
  });

  /* ---------------------------------------------------------------- policies */

  app.get('/academy/policies', async (request) => ({ items: await academy.listPolicies(requireActor(request)) }));
  app.post('/academy/policies', async (request, reply) => {
    reply.code(201);
    return academy.savePolicy(requireActor(request), null, parse(policyBody, request.body));
  });
  app.get('/academy/policies/:id', async (request) => academy.getPolicy(requireActor(request), parse(idParam, request.params).id));
  app.put('/academy/policies/:id', async (request) => academy.savePolicy(requireActor(request), parse(idParam, request.params).id, parse(policyBody, request.body)));
  app.post('/academy/policies/:id/publish', async (request) => {
    const { changeNote } = parse(z.object({ changeNote: z.string().max(500).nullable().optional() }), request.body);
    return academy.publishPolicy(requireActor(request), parse(idParam, request.params).id, changeNote ?? null);
  });
  app.post('/academy/policies/:id/retire', async (request, reply) => {
    await academy.retirePolicy(requireActor(request), parse(idParam, request.params).id);
    reply.code(204);
  });
  app.post('/academy/policies/:id/acknowledge', async (request) => academy.acknowledgePolicy(requireActor(request), parse(idParam, request.params).id, request.ip ?? null));
  app.get('/academy/policies/:id/coverage', async (request) => academy.policyCoverage(requireActor(request), parse(idParam, request.params).id));
}
