/**
 * Leave and delegation routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../core/validation.js';
import { requireActor, withIdempotency } from '../context.js';
import * as leave from '../../domains/leave.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export async function leaveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/leave/types', async (request) => {
    const actor = requireActor(request);
    return { items: await leave.listTypes(actor) };
  });

  app.post('/leave/types', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        key: z.string().min(1).max(40),
        name: z.string().min(1).max(80),
        paid: z.boolean().optional(),
        requiresApproval: z.boolean().optional(),
        deductsBalance: z.boolean().optional(),
        defaultAnnualDays: z.number().min(0).max(365).optional(),
        colour: z.string().max(16).optional(),
      }),
      request.body,
    );
    reply.code(201);
    return leave.createType(actor, input);
  });

  app.get('/leave/balances', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        userId: z.string().uuid().optional(),
        year: z.coerce.number().int().min(2000).max(2100).optional(),
      }),
      request.query,
    );
    return {
      items: await leave.balancesFor(actor, query.userId ?? actor.userId, query.year),
    };
  });

  app.put('/leave/balances', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        userId: z.string().uuid(),
        leaveTypeId: z.string().uuid(),
        year: z.number().int().min(2000).max(2100),
        entitledDays: z.number().min(0).max(365),
        carriedDays: z.number().min(0).max(365).optional(),
      }),
      request.body,
    );
    await leave.setEntitlement(actor, input);
    return reply.code(204).send();
  });

  app.get('/leave/requests', async (request) => {
    const actor = requireActor(request);
    const query = parse(
      z.object({
        userId: z.string().uuid().optional(),
        from: dateString.optional(),
        to: dateString.optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
      }),
      request.query,
    );
    return { items: await leave.listLeave(actor, query) };
  });

  app.post('/leave/requests', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        leaveTypeId: z.string().uuid(),
        startDate: dateString,
        endDate: dateString,
        halfDayStart: z.boolean().optional(),
        halfDayEnd: z.boolean().optional(),
        reason: z.string().max(1000).nullable().optional(),
      }),
      request.body,
    );
    return withIdempotency(request, reply, 'POST /leave/requests', async () => {
      const created = await leave.requestLeave(actor, input, request.correlationId);
      return { statusCode: 201, body: created };
    });
  });

  app.post('/leave/requests/:id/cancel', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), request.body);
    await leave.cancelLeave(actor, id, input.reason);
    return reply.code(204).send();
  });

  /** Who is away over a window: the question asked before planning anything. */
  app.get('/leave/away', async (request) => {
    const actor = requireActor(request);
    const query = parse(z.object({ from: dateString, to: dateString }), request.query);
    return { items: await leave.whoIsAway(actor, query.from, query.to) };
  });

  // ---------------------------------------------------------------- delegation

  app.get('/delegations', async (request) => {
    const actor = requireActor(request);
    const query = parse(z.object({ userId: z.string().uuid().optional() }), request.query);
    return { items: await leave.listDelegations(actor, query.userId) };
  });

  app.post('/delegations', async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(
      z.object({
        fromUserId: z.string().uuid().optional(),
        toUserId: z.string().uuid(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        reason: z.string().max(500).nullable().optional(),
        leaveRequestId: z.string().uuid().nullable().optional(),
        /** Also move decisions already sitting with them, not just future ones. */
        reassignExisting: z.boolean().optional(),
      }),
      request.body,
    );
    const delegation = await leave.createDelegation(actor, input);
    const reassigned = input.reassignExisting
      ? await leave.reassignActiveSteps(
          actor,
          input.fromUserId ?? actor.userId,
          input.toUserId,
        )
      : 0;
    reply.code(201);
    return { delegation, reassigned };
  });

  app.delete('/delegations/:id', async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    await leave.revokeDelegation(actor, id);
    return reply.code(204).send();
  });
}
