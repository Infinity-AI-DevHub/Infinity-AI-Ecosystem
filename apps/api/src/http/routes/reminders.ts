/**
 * Reminders: the things somebody has to do on a day, and who else should be told.
 *
 * Everything here is scoped to the caller — their own reminders and the ones they watch.
 * There is deliberately no listing of everybody's: a reminder is as often a private note
 * as a company duty.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor } from '../context.js';
import * as reminders from '../../domains/reminders.js';

const idParam = z.object({ id: z.string().uuid() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-14');

const body = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(5000).nullable().optional(),
  kind: z.enum(['task', 'payment', 'renewal', 'other']).optional(),
  dueOn: day,
  /** How many days before it is due the reminding starts. */
  leadDays: z.number().int().min(0).max(3650).optional(),
  repeatEvery: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
  repeatInterval: z.number().int().min(1).max(99).optional(),
  amount: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  watcherIds: z.array(z.string().uuid()).max(50).optional(),
});

export async function reminderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reminders', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({ includeDone: z.coerce.boolean().optional() }),
      request.query,
    );
    return { items: await reminders.listMine(actor, { includeDone: query.includeDone }) };
  });

  app.post('/reminders', async (request, reply) => {
    const actor = requireActor(request);
    reply.code(201);
    return reminders.createReminder(actor, parse(body, request.body));
  });

  app.get('/reminders/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return reminders.getReminder(requireActor(request), id);
  });

  app.patch('/reminders/:id', async (request) => {
    const { id } = parse(idParam, request.params);
    return reminders.updateReminder(requireActor(request), id, parse(body.partial(), request.body));
  });

  /** Done with this one — which for a repeating reminder means "on to the next". */
  app.post('/reminders/:id/complete', async (request) => {
    const { id } = parse(idParam, request.params);
    return reminders.complete(requireActor(request), id);
  });

  app.post('/reminders/:id/snooze', async (request) => {
    const { id } = parse(idParam, request.params);
    const { until } = parse(z.object({ until: day }), request.body);
    return reminders.snooze(requireActor(request), id, until);
  });

  app.delete('/reminders/:id', async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await reminders.cancel(requireActor(request), id);
    return reply.code(204).send();
  });
}
