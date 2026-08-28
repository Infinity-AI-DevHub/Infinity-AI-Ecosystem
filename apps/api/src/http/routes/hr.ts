/**
 * Employment record, review and goal routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as hr from '../../domains/hr.js';

const idParam = z.object({ id: z.string().uuid() });
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export async function hrRoutes(app: FastifyInstance): Promise<void> {
  app.get('/hr/employment/:userId', async (request) => {
    const actor = requireActor(request);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), request.params);
    return { items: await hr.employmentHistory(actor, userId) };
  });

  app.post('/hr/employment/:userId', async (request, reply) => {
    const actor = requireActor(request);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), request.params);
    const input = parse(
      z.object({
        employmentType: z.enum(['permanent', 'fixed_term', 'contractor', 'intern', 'part_time']).optional(),
        jobTitle: z.string().min(1).max(160),
        departmentId: z.string().uuid().nullable().optional(),
        managerId: z.string().uuid().nullable().optional(),
        effectiveFrom: dateString,
        salary: z.number().nonnegative().max(1e9).nullable().optional(),
        salaryCurrency: z.string().length(3).optional(),
        salaryPeriod: z.enum(['year', 'month', 'day', 'hour']).optional(),
        weeklyHours: z.number().min(0).max(168).nullable().optional(),
        probationEnds: dateString.nullable().optional(),
        changeReason: z.string().max(300).nullable().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return hr.recordEmployment(actor, userId, input);
  });

  // ---------------------------------------------------------------- reviews

  app.get('/hr/cycles', async (request) => {
    const actor = requireActor(request);
    return { items: await hr.listCycles(actor) };
  });

  app.post('/hr/cycles', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        name: z.string().min(1).max(120),
        opensOn: dateString,
        closesOn: dateString,
      }),
      request.body,
    );
    reply.code(201);
    return hr.openCycle(actor, input);
  });

  app.get('/hr/reviews', async (request) => {
    const actor = requireActor(request);
    return { items: await hr.myReviews(actor) };
  });

  app.get('/hr/reviews/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return hr.getReview(actor, id);
  });

  app.put('/hr/reviews/:id/self', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(z.object({ text: z.string().max(50_000) }), request.body);
    await hr.saveSelfAssessment(actor, id, input.text);
    return reply.code(204).send();
  });

  app.put('/hr/reviews/:id/manager', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        text: z.string().max(50_000),
        rating: z.string().max(30).nullable().optional(),
        share: z.boolean().optional(),
      }),
      request.body,
    );
    await hr.saveManagerAssessment(actor, id, input);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- goals

  app.get('/hr/goals', async (request) => {
    const actor = requireActor(request);
    const query = parse(z.object({ userId: z.string().uuid().optional() }), request.query);
    return { items: await hr.listGoals(actor, query.userId) };
  });

  app.post('/hr/goals', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        userId: z.string().uuid().optional(),
        title: z.string().min(1).max(300),
        detail: z.string().max(5000).nullable().optional(),
        dueOn: dateString.nullable().optional(),
        cycleId: z.string().uuid().nullable().optional(),
      }),
      request.body,
    );
    reply.code(201);
    return hr.createGoal(actor, input);
  });

  app.patch('/hr/goals/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        progress: z.number().int().min(0).max(100).optional(),
        status: z.enum(['active', 'at_risk', 'achieved', 'dropped']).optional(),
        title: z.string().min(1).max(300).optional(),
        detail: z.string().max(5000).nullable().optional(),
      }),
      request.body,
    );
    await hr.updateGoal(actor, id, input);
    return reply.code(204).send();
  });
}
