/**
 * Attendance: clocking in and out, and reviewing what came back.
 *
 * The heartbeat is the busiest route in the application while anyone is working, so it
 * does exactly one indexed UPDATE and returns almost nothing.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as attendance from '../../domains/attendance.js';

const idParam = z.object({ id: z.string().uuid() });

export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  // ---- the person working ---------------------------------------------------
  app.get('/attendance/me', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({ days: z.coerce.number().int().min(1).max(365).optional() }),
      request.query,
    );
    return attendance.myAttendance(actor, query.days);
  });

  app.post('/attendance/clock-in', async (request, reply) => {
    const actor = requireActor(request);
    reply.code(201);
    return attendance.clockIn(actor);
  });

  app.post('/attendance/clock-out', async (request) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        note: z.string().max(10_000).nullable().optional(),
        evidenceFileIds: z.array(z.string().uuid()).max(20).optional(),
      }),
      request.body,
    );
    return attendance.clockOut(actor, input);
  });

  /**
   * Still here.
   *
   * A 200 with `{ open: false }` rather than an error when nothing is running: the app
   * polls this, and an app that has been auto-closed needs to learn that quietly and
   * update its own state, not handle an exception every minute.
   */
  app.post('/attendance/heartbeat', async (request) => {
    const actor = requireActor(request);
    return attendance.heartbeat(actor);
  });

  // ---- the reviewer --------------------------------------------------------
  app.get('/attendance', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        state: z.enum(['pending', 'approved', 'disqualified']).optional(),
        flaggedOnly: z.coerce.boolean().optional(),
        userId: z.string().uuid().optional(),
        days: z.coerce.number().int().min(1).max(365).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      request.query,
    );
    return { items: await attendance.listForReview(actor, query) };
  });

  app.get('/attendance/:id', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    return attendance.getSession(actor, id);
  });

  app.post('/attendance/:id/review', async (request) => {
    const actor = requireActor(request);
    const { id } = parse(idParam, request.params);
    const input = parse(
      z.object({
        state: z.enum(['approved', 'disqualified']),
        note: z.string().max(4000).nullable().optional(),
      }),
      request.body,
    );
    return attendance.review(actor, id, input);
  });
}
